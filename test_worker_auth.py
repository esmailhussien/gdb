import json
import unittest
import urllib.error
from unittest.mock import patch

import worker_auth


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class WorkerAuthenticationTests(unittest.TestCase):
    def test_fails_closed_when_authentication_is_not_configured(self):
        with patch.multiple(
            worker_auth,
            WORKER_TOKEN="",
            SUPABASE_URL="",
            SUPABASE_ANON_KEY="",
            ALLOW_UNAUTHENTICATED=False,
            RUNNING_ON_RENDER=False,
        ):
            with self.assertRaises(worker_auth.AuthenticationError) as raised:
                worker_auth.require_token({})
            self.assertEqual(raised.exception.status_code, 503)

    def test_explicit_development_mode_allows_local_request(self):
        with patch.multiple(
            worker_auth,
            WORKER_TOKEN="",
            SUPABASE_URL="",
            SUPABASE_ANON_KEY="",
            ALLOW_UNAUTHENTICATED=True,
            RUNNING_ON_RENDER=False,
        ):
            identity = worker_auth.require_token({})
            self.assertEqual(identity["auth_type"], "development")

    def test_private_service_token_uses_constant_time_comparison_path(self):
        with patch.multiple(
            worker_auth,
            WORKER_TOKEN="private-service-token",
            SUPABASE_URL="",
            SUPABASE_ANON_KEY="",
            ALLOW_UNAUTHENTICATED=False,
            RUNNING_ON_RENDER=False,
        ):
            identity = worker_auth.require_token({"authorization": "Bearer private-service-token"})
            self.assertEqual(identity["auth_type"], "service_token")

    def test_supabase_user_token_is_validated_remotely(self):
        with patch.multiple(
            worker_auth,
            WORKER_TOKEN="",
            SUPABASE_URL="https://project.supabase.co",
            SUPABASE_ANON_KEY="public-anon-key",
            ALLOW_UNAUTHENTICATED=False,
            RUNNING_ON_RENDER=False,
        ), patch("worker_auth.urllib.request.urlopen", return_value=_Response({"id": "user-123"})) as urlopen:
            identity = worker_auth.require_token({"authorization": "Bearer signed-user-token"})

        self.assertEqual(identity, {"auth_type": "supabase", "user_id": "user-123"})
        request = urlopen.call_args.args[0]
        self.assertEqual(request.headers["Authorization"], "Bearer signed-user-token")
        self.assertEqual(request.headers["Apikey"], "public-anon-key")

    def test_rejects_invalid_supabase_token(self):
        error = urllib.error.HTTPError(
            "https://project.supabase.co/auth/v1/user",
            401,
            "Unauthorized",
            {},
            None,
        )
        with patch.multiple(
            worker_auth,
            WORKER_TOKEN="",
            SUPABASE_URL="https://project.supabase.co",
            SUPABASE_ANON_KEY="public-anon-key",
            ALLOW_UNAUTHENTICATED=False,
            RUNNING_ON_RENDER=False,
        ), patch("worker_auth.urllib.request.urlopen", side_effect=error):
            with self.assertRaises(worker_auth.AuthenticationError) as raised:
                worker_auth.require_token({"authorization": "Bearer invalid-token"})
            self.assertEqual(raised.exception.status_code, 401)

    def test_render_ignores_the_unauthenticated_development_escape_hatch(self):
        with patch.multiple(
            worker_auth,
            WORKER_TOKEN="",
            SUPABASE_URL="",
            SUPABASE_ANON_KEY="",
            ALLOW_UNAUTHENTICATED=True,
            RUNNING_ON_RENDER=True,
        ):
            self.assertEqual(worker_auth.authentication_status(), "unconfigured")
            with self.assertRaises(worker_auth.AuthenticationError) as raised:
                worker_auth.require_token({})

        self.assertEqual(raised.exception.status_code, 503)

    def test_authentication_status_reports_required_without_disclosing_the_method(self):
        with patch.multiple(
            worker_auth,
            WORKER_TOKEN="private-service-token",
            SUPABASE_URL="https://project.supabase.co",
            SUPABASE_ANON_KEY="public-anon-key",
            ALLOW_UNAUTHENTICATED=False,
            RUNNING_ON_RENDER=True,
        ):
            self.assertEqual(worker_auth.authentication_status(), "required")


if __name__ == "__main__":
    unittest.main()
