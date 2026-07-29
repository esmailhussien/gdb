"""Authentication policy for the FileGDB worker.

This module intentionally uses only the Python standard library so the policy
can be tested without FastAPI, GDAL, or the production container image.
"""

import hmac
import json
import os
import urllib.error
import urllib.request


WORKER_TOKEN = os.getenv("GDB_IMPORT_WORKER_TOKEN", "").strip()
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "").strip()
ALLOW_UNAUTHENTICATED = os.getenv("ALLOW_UNAUTHENTICATED", "").strip().lower() == "true"
RUNNING_ON_RENDER = os.getenv("RENDER", "").strip().lower() == "true"
AUTH_TIMEOUT_SECONDS = int(os.getenv("AUTH_TIMEOUT_SECONDS", "8"))


class AuthenticationError(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def bearer_token(headers):
    auth = headers.get("authorization", "") if headers else ""
    return auth[7:].strip() if auth.lower().startswith("bearer ") else auth.strip()


def unauthenticated_access_enabled():
    """Allow the development escape hatch locally, never on Render."""
    return ALLOW_UNAUTHENTICATED and not RUNNING_ON_RENDER


def authentication_status():
    if unauthenticated_access_enabled():
        return "development"
    if WORKER_TOKEN or (SUPABASE_URL and SUPABASE_ANON_KEY):
        return "required"
    return "unconfigured"


def validate_supabase_access_token(token):
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        return None

    request = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={
            "Authorization": f"Bearer {token}",
            "apikey": SUPABASE_ANON_KEY,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=AUTH_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload if isinstance(payload, dict) and payload.get("id") else None
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return None
        raise AuthenticationError(503, "FileGDB worker authentication service is unavailable.") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise AuthenticationError(503, "FileGDB worker authentication service is unavailable.") from exc


def require_token(headers):
    token = bearer_token(headers)

    if WORKER_TOKEN and token and hmac.compare_digest(token, WORKER_TOKEN):
        return {"auth_type": "service_token"}

    if token and SUPABASE_URL and SUPABASE_ANON_KEY:
        user = validate_supabase_access_token(token)
        if user:
            return {"auth_type": "supabase", "user_id": user["id"]}

    if unauthenticated_access_enabled():
        return {"auth_type": "development"}

    if not WORKER_TOKEN and not (SUPABASE_URL and SUPABASE_ANON_KEY):
        raise AuthenticationError(503, "FileGDB worker authentication is not configured.")

    raise AuthenticationError(401, "A valid Mapplex session is required.")
