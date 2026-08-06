import { Capacitor } from '@capacitor/core';
import { Purchases, LOG_LEVEL } from '@revenuecat/purchases-capacitor';
import { WorkspaceManager } from '../modules/workspace/WorkspaceManager.js';

const DEFAULT_AI_POINTS_PRODUCTS = {
    addon_ai_50: 50,
};

const DEFAULT_STORAGE_PRODUCTS_MB = {
    addon_storage_1gb: 1024,
    addon_storage_5gb: 5120,
};

const DEFAULT_SUBSCRIPTION_PRODUCTS = {
    sub_pro_monthly: 'pro',
    sub_team_monthly: 'geova_ai',
};

function readEnv(name) {
    try {
        const value = import.meta.env?.[name];
        return typeof value === 'string' && value.trim() ? value.trim() : '';
    } catch (_) {
        return '';
    }
}

function readProductMap(envName, fallback) {
    const raw = readEnv(envName);
    if (!raw) return fallback;

    try {
        const parsed = JSON.parse(raw);
        const normalized = {};
        Object.entries(parsed || {}).forEach(([productId, amount]) => {
            const n = Number(amount);
            if (productId && Number.isFinite(n) && n > 0) {
                normalized[productId] = Math.floor(n);
            }
        });
        return Object.keys(normalized).length ? normalized : fallback;
    } catch (err) {
        console.warn(`[RevenueCat] Invalid ${envName}; using default product map`, err);
        return fallback;
    }
}

function readTierMap(envName, fallback) {
    const raw = readEnv(envName);
    if (!raw) return fallback;

    try {
        const parsed = JSON.parse(raw);
        const normalized = {};
        Object.entries(parsed || {}).forEach(([productId, tier]) => {
            if (productId && typeof tier === 'string' && tier.trim()) {
                normalized[productId] = tier.trim().toLowerCase();
            }
        });
        return Object.keys(normalized).length ? normalized : fallback;
    } catch (err) {
        console.warn(`[RevenueCat] Invalid ${envName}; using default tier map`, err);
        return fallback;
    }
}

function baseProductId(productId) {
    return String(productId || '').split(':')[0];
}

function lookupAmount(map, productId) {
    if (!productId) return null;
    return map[productId] || map[baseProductId(productId)] || null;
}

function formatStorage(mb) {
    const n = Number(mb) || 0;
    if (n >= 1024) return `${Number((n / 1024).toFixed(2))} GB`;
    return `${n} MB`;
}

function isUserCancelled(error) {
    return Boolean(
        error?.userCancelled ||
        error?.userInfo?.userCancelled ||
        String(error?.code || '').toLowerCase().includes('cancel')
    );
}

class _RevenueCatBillingService {
    constructor() {
        this._configured = false;
        this._configuredWorkspaceId = null;
        this._configurePromise = null;
        this._offeringsCache = null;
        this._offeringsFetchedAt = 0;
        this._customerInfoListenerId = null;
        this.aiProductMap = readProductMap('VITE_REVENUECAT_AI_POINTS_PRODUCTS', DEFAULT_AI_POINTS_PRODUCTS);
        this.storageProductMap = readProductMap('VITE_REVENUECAT_STORAGE_PRODUCTS', DEFAULT_STORAGE_PRODUCTS_MB);
        this.subscriptionProductMap = readTierMap('VITE_REVENUECAT_SUBSCRIPTION_PRODUCTS', DEFAULT_SUBSCRIPTION_PRODUCTS);
    }

    get platform() {
        return Capacitor.getPlatform();
    }

    get isNativeBillingAvailable() {
        return Capacitor.isNativePlatform() && ['ios', 'android'].includes(this.platform);
    }

    get webCheckoutUrl() {
        return readEnv('VITE_REVENUECAT_WEB_CHECKOUT_URL');
    }

    get hasConfiguredApiKey() {
        return Boolean(this._apiKeyForPlatform());
    }

    _apiKeyForPlatform() {
        if (this.platform === 'ios') {
            return readEnv('VITE_REVENUECAT_IOS_API_KEY');
        }
        if (this.platform === 'android') {
            return readEnv('VITE_REVENUECAT_ANDROID_API_KEY');
        }
        return '';
    }

    async ensureConfigured({ forceWorkspaceSync = false } = {}) {
        const workspaceId = WorkspaceManager.activeWorkspaceId;
        if (!workspaceId) {
            throw new Error('Select a workspace before opening billing.');
        }

        if (!this.isNativeBillingAvailable) {
            return {
                configured: false,
                reason: 'web',
                webCheckoutUrl: this.webCheckoutUrl,
            };
        }

        const apiKey = this._apiKeyForPlatform();
        if (!apiKey) {
            return {
                configured: false,
                reason: 'missing_api_key',
                platform: this.platform,
            };
        }

        if (this._configurePromise) {
            await this._configurePromise;
        }

        if (!this._configured) {
            this._configurePromise = this._configure(workspaceId, apiKey);
            try {
                await this._configurePromise;
            } finally {
                this._configurePromise = null;
            }
            return { configured: true, workspaceId };
        }

        if (forceWorkspaceSync || this._configuredWorkspaceId !== workspaceId) {
            await Purchases.logIn({ appUserID: workspaceId });
            this._configuredWorkspaceId = workspaceId;
            await this._syncWorkspaceAttributes();
            this._offeringsCache = null;
        }

        return { configured: true, workspaceId };
    }

    async _configure(workspaceId, apiKey) {
        const debugEnabled = readEnv('VITE_REVENUECAT_DEBUG') === 'true' || import.meta.env?.DEV;
        await Purchases.setLogLevel({ level: debugEnabled ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN });
        await Purchases.configure({
            apiKey,
            appUserID: workspaceId,
        });

        this._configured = true;
        this._configuredWorkspaceId = workspaceId;
        await this._syncWorkspaceAttributes();
        await this._attachCustomerInfoListener();
    }

    async _attachCustomerInfoListener() {
        if (this._customerInfoListenerId) return;
        try {
            this._customerInfoListenerId = await Purchases.addCustomerInfoUpdateListener((customerInfo) => {
                document.dispatchEvent(new CustomEvent('billing:customer-info-updated', {
                    detail: { customerInfo, workspaceId: this._configuredWorkspaceId }
                }));
            });
        } catch (err) {
            console.warn('[RevenueCat] Customer info listener unavailable:', err);
        }
    }

    async _syncWorkspaceAttributes() {
        const workspace = WorkspaceManager.activeWorkspace;
        const workspaceId = WorkspaceManager.activeWorkspaceId;
        if (!workspaceId) return;

        try {
            await Purchases.setAttributes({
                workspace_id: workspaceId,
                workspace_name: workspace?.name || null,
                workspace_tier: workspace?.subscription_tier || null,
                workspace_role: WorkspaceManager.activeRole || null,
            });
        } catch (err) {
            console.warn('[RevenueCat] Failed to sync workspace attributes:', err);
        }
    }

    async getOfferings({ force = false } = {}) {
        const status = await this.ensureConfigured();
        if (!status.configured) {
            return {
                status,
                packages: [],
                aiPackages: [],
                storagePackages: [],
            };
        }

        const now = Date.now();
        if (!force && this._offeringsCache && now - this._offeringsFetchedAt < 60_000) {
            return this._offeringsCache;
        }

        const offerings = await Purchases.getOfferings();
        const packages = this._normalizePackages(offerings?.current?.availablePackages || []);
        const result = {
            status,
            offerings,
            packages,
            subscriptionPackages: packages.filter(pkg => pkg.kind === 'subscription'),
            aiPackages: packages.filter(pkg => pkg.kind === 'ai'),
            storagePackages: packages.filter(pkg => pkg.kind === 'storage'),
        };

        this._offeringsCache = result;
        this._offeringsFetchedAt = now;
        return result;
    }

    _normalizePackages(packages) {
        return packages.map((pkg) => {
            const product = pkg.product || {};
            const productId = product.identifier;
            const subscriptionTier = lookupAmount(this.subscriptionProductMap, productId);
            const aiPoints = lookupAmount(this.aiProductMap, productId);
            const storageMb = lookupAmount(this.storageProductMap, productId);
            const kind = subscriptionTier ? 'subscription'
                : aiPoints ? 'ai'
                : storageMb ? 'storage'
                : 'other';

            return {
                id: `${pkg.identifier || 'package'}:${productId || Math.random()}`,
                kind,
                rawPackage: pkg,
                packageIdentifier: pkg.identifier,
                productId,
                title: product.title || this._fallbackTitle(kind, aiPoints, storageMb, subscriptionTier),
                description: product.description || this._fallbackDescription(kind),
                priceString: product.priceString || '',
                price: product.price,
                currencyCode: product.currencyCode,
                aiPoints,
                storageMb,
                subscriptionTier,
                displayAmount: kind === 'subscription'
                    ? `${this._tierDisplayLabel(subscriptionTier)} Plan`
                    : kind === 'ai'
                        ? `${aiPoints} AI points`
                        : kind === 'storage'
                            ? `${formatStorage(storageMb)} storage`
                            : productId,
                recurring: kind === 'subscription',
            };
        }).sort((a, b) => {
            if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
            return (a.aiPoints || a.storageMb || 0) - (b.aiPoints || b.storageMb || 0);
        });
    }

    _fallbackTitle(kind, aiPoints, storageMb, subscriptionTier) {
        if (kind === 'subscription') return `${this._tierDisplayLabel(subscriptionTier)} Plan`;
        if (kind === 'ai') return `${aiPoints} AI Points`;
        if (kind === 'storage') return `${formatStorage(storageMb)} Extra Storage`;
        return 'Workspace Add-on';
    }

    _fallbackDescription(kind) {
        if (kind === 'subscription') return 'Monthly workspace subscription plan.';
        if (kind === 'ai') return 'One-time top-up for Geova AI tools.';
        if (kind === 'storage') return 'One-time permanent storage boost.';
        return 'RevenueCat product';
    }

    _tierDisplayLabel(tier) {
        if (tier === 'pro') return 'Pro';
        if (tier === 'geova_ai') return 'Teams';
        return String(tier || 'Plan').charAt(0).toUpperCase() + String(tier || '').slice(1);
    }

    async purchasePackage(normalizedPackage) {
        if (!normalizedPackage?.rawPackage) {
            throw new Error('No RevenueCat package selected.');
        }

        await this.ensureConfigured({ forceWorkspaceSync: true });

        try {
            const result = await Purchases.purchasePackage({
                aPackage: normalizedPackage.rawPackage,
            });
            this._offeringsCache = null;

            document.dispatchEvent(new CustomEvent('billing:purchase-completed', {
                detail: {
                    workspaceId: WorkspaceManager.activeWorkspaceId,
                    productId: normalizedPackage.productId,
                    kind: normalizedPackage.kind,
                    result,
                }
            }));

            return result;
        } catch (err) {
            if (isUserCancelled(err)) {
                err.isUserCancelled = true;
            }
            throw err;
        }
    }

    async restorePurchases() {
        await this.ensureConfigured({ forceWorkspaceSync: true });
        const result = await Purchases.restorePurchases();
        document.dispatchEvent(new CustomEvent('billing:purchase-restored', {
            detail: {
                workspaceId: WorkspaceManager.activeWorkspaceId,
                result,
            }
        }));
        return result;
    }
}

export const RevenueCatBillingService = new _RevenueCatBillingService();
