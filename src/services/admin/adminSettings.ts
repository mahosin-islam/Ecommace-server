import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/auth.js';
import { requireRole } from '../../middlewares/role.js';
import { prisma } from '../../lib/prisma.js';
import { sendSuccess } from '../../utils/response.js';
import { BadRequestError } from '../../utils/appError.js';

// ── Settings Definitions ─────────────────────────────────────────────────────

type SettingType = 'string' | 'number' | 'boolean';

interface SettingDefinition {
  key: string;
  value: string;
  type: SettingType;
  group: string;
  description: string;
  min?: number;
  max?: number;
  integer?: boolean;
}

const SETTING_DEFINITIONS: SettingDefinition[] = [
  { key: 'store.name', value: 'Apex Store', type: 'string', group: 'general', description: 'Store display name' },
  { key: 'store.email', value: 'support@example.com', type: 'string', group: 'general', description: 'Store contact email' },
  { key: 'store.phone', value: '', type: 'string', group: 'general', description: 'Support phone number' },
  { key: 'store.address', value: '', type: 'string', group: 'general', description: 'Physical store or atelier address' },
  { key: 'store.logo_url', value: '', type: 'string', group: 'general', description: 'Store logo image URL' },
  { key: 'store.favicon_url', value: '', type: 'string', group: 'general', description: 'Store favicon URL' },
  { key: 'store.currency', value: 'USD', type: 'string', group: 'localization', description: 'ISO 4217 base currency code' },
  { key: 'store.currency_symbol', value: '$', type: 'string', group: 'localization', description: 'Base currency symbol' },
  { key: 'store.locale', value: 'en-US', type: 'string', group: 'localization', description: 'Locale for formatting' },
  { key: 'store.timezone', value: 'UTC', type: 'string', group: 'localization', description: 'Store timezone' },
  { key: 'store.date_format', value: 'MMM d, yyyy', type: 'string', group: 'localization', description: 'Display date format' },
  { key: 'store.number_format', value: 'en-US', type: 'string', group: 'localization', description: 'Display number format' },
  { key: 'shipping.flat_rate', value: '5.99', type: 'number', group: 'shipping', description: 'Standard flat shipping rate', min: 0 },
  { key: 'shipping.free_threshold', value: '75.00', type: 'number', group: 'shipping', description: 'Free shipping order threshold', min: 0 },
  { key: 'shipping.express_rate', value: '14.99', type: 'number', group: 'shipping', description: 'Express shipping rate', min: 0 },
  { key: 'tax.rate_percent', value: '8.25', type: 'number', group: 'tax', description: 'Default sales tax rate percentage', min: 0, max: 100 },
  { key: 'tax.inclusive', value: 'false', type: 'boolean', group: 'tax', description: 'Whether displayed prices include tax' },
  { key: 'feature.guest_checkout', value: 'true', type: 'boolean', group: 'features', description: 'Allow checkout without registration' },
  { key: 'feature.reviews_enabled', value: 'true', type: 'boolean', group: 'features', description: 'Enable customer product reviews' },
  { key: 'feature.review_moderation', value: 'false', type: 'boolean', group: 'features', description: 'Require approval before reviews are public' },
  { key: 'feature.wishlist_enabled', value: 'true', type: 'boolean', group: 'features', description: 'Enable customer wishlists' },
  { key: 'feature.inventory_tracking', value: 'true', type: 'boolean', group: 'features', description: 'Track and decrement inventory' },
  { key: 'feature.low_stock_threshold', value: '5', type: 'number', group: 'features', description: 'Default low stock alert threshold', min: 0, integer: true },
];

const ALIASES: Record<string, string> = {
  store_name: 'store.name',
  store_email: 'store.email',
  store_phone: 'store.phone',
  store_address: 'store.address',
  store_logo_url: 'store.logo_url',
  store_favicon_url: 'store.favicon_url',
  currency_code: 'store.currency',
  currency_symbol: 'store.currency_symbol',
  locale: 'store.locale',
  timezone: 'store.timezone',
  free_shipping_threshold: 'shipping.free_threshold',
  default_shipping_rate: 'shipping.flat_rate',
  tax_rate: 'tax.rate_percent',
  tax_inclusive: 'tax.inclusive',
  feature_guest_checkout: 'feature.guest_checkout',
  feature_reviews: 'feature.reviews_enabled',
  feature_wishlist: 'feature.wishlist_enabled',
  feature_inventory_tracking: 'feature.inventory_tracking',
};

const DEFINITION_BY_KEY = new Map(SETTING_DEFINITIONS.map((setting) => [setting.key, setting]));

const updateSettingsSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));

// ── Validation Helpers ───────────────────────────────────────────────────────

function canonicalKey(key: string): string {
  return ALIASES[key] ?? key;
}

function parseSettingValue(definition: SettingDefinition, input: string | number | boolean): string {
  if (definition.type === 'string') {
    if (typeof input !== 'string') {
      throw new BadRequestError(`${definition.key} must be a string`);
    }
    const value = input.trim();
    if (definition.key === 'store.currency') {
      const code = value.toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) {
        throw new BadRequestError('store.currency must be a 3-letter ISO currency code');
      }
      return code;
    }
    if (definition.key === 'store.email' && value) {
      if (!z.string().email().safeParse(value).success) {
        throw new BadRequestError('store.email must be a valid email address');
      }
    }
    if ((definition.key === 'store.logo_url' || definition.key === 'store.favicon_url') && value) {
      if (!z.string().url().safeParse(value).success) {
        throw new BadRequestError(`${definition.key} must be a valid URL`);
      }
    }
    if (definition.key === 'store.timezone' && value) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
      } catch {
        throw new BadRequestError('store.timezone is not a valid IANA timezone');
      }
    }
    return value;
  }

  if (definition.type === 'boolean') {
    if (typeof input === 'boolean') return String(input);
    if (input === 'true' || input === 'false') return input;
    throw new BadRequestError(`${definition.key} must be a boolean`);
  }

  const numeric = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(numeric)) {
    throw new BadRequestError(`${definition.key} must be a number`);
  }
  if (definition.integer && !Number.isInteger(numeric)) {
    throw new BadRequestError(`${definition.key} must be an integer`);
  }
  if (definition.min !== undefined && numeric < definition.min) {
    throw new BadRequestError(`${definition.key} must be at least ${definition.min}`);
  }
  if (definition.max !== undefined && numeric > definition.max) {
    throw new BadRequestError(`${definition.key} must be at most ${definition.max}`);
  }
  return String(numeric);
}

function groupSettings(rows: { key: string; value: string; type: string; group: string }[]) {
  const grouped: Record<string, Record<string, string | number | boolean>> = {};
  const values: Record<string, string | number | boolean> = {};

  for (const row of rows) {
    const definition = DEFINITION_BY_KEY.get(row.key);
    if (!definition) continue;

    let value: string | number | boolean = row.value;
    if (definition.type === 'number') value = parseFloat(row.value);
    else if (definition.type === 'boolean') value = row.value === 'true';

    if (!grouped[definition.group]) grouped[definition.group] = {};
    grouped[definition.group][definition.key] = value;
    values[definition.key] = value;
  }

  return { grouped, values };
}

// ── Service Class ────────────────────────────────────────────────────────────

export class AdminSettingsService {
  async getSettings() {
    const rows = await prisma.storeSetting.findMany({
      orderBy: [{ group: 'asc' }, { key: 'asc' }],
    });

    const byKey = new Map(rows.map((row) => [row.key, row]));
    const canonicalRows = SETTING_DEFINITIONS.map((definition) => {
      const row = byKey.get(definition.key) ?? byKey.get(
        Object.keys(ALIASES).find((alias) => ALIASES[alias] === definition.key) ?? '',
      );
      return {
        key: definition.key,
        value: row?.value ?? definition.value,
        type: definition.type,
        group: definition.group,
        description: definition.description,
      };
    });

    const { grouped, values } = groupSettings(canonicalRows);

    return {
      grouped,
      values,
      definitions: SETTING_DEFINITIONS.map(({ key, type, group, description }) => ({
        key,
        type,
        group,
        description,
      })),
      aliases: ALIASES,
    };
  }

  async updateSettings(data: z.infer<typeof updateSettingsSchema>) {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      throw new BadRequestError('At least one setting must be provided');
    }

    const normalized = new Map<string, string>();
    for (const [rawKey, rawValue] of entries) {
      const key = canonicalKey(rawKey);
      const definition = DEFINITION_BY_KEY.get(key);
      if (!definition) {
        throw new BadRequestError(`Unknown setting: ${rawKey}`);
      }
      normalized.set(key, parseSettingValue(definition, rawValue));
    }

    await prisma.$transaction(
      [...normalized.entries()].map(([key, value]) => {
        const definition = DEFINITION_BY_KEY.get(key)!;
        return prisma.storeSetting.upsert({
          where: { key },
          create: {
            key,
            value,
            type: definition.type,
            group: definition.group,
            description: definition.description,
          },
          update: {
            value,
            type: definition.type,
            group: definition.group,
            description: definition.description,
          },
        });
      }),
    );

    return this.getSettings();
  }

  async seedDefaults() {
    const existing = await prisma.storeSetting.findMany({
      where: { key: { in: SETTING_DEFINITIONS.map((setting) => setting.key) } },
      select: { key: true },
    });
    const existingKeys = new Set(existing.map((setting) => setting.key));

    const aliasesInDb = await prisma.storeSetting.findMany({
      where: { key: { in: Object.keys(ALIASES) } },
    });
    const aliasByCanonical = new Map(aliasesInDb.map((row) => [ALIASES[row.key]!, row]));

    const toCreate = SETTING_DEFINITIONS.filter(
      (definition) => !existingKeys.has(definition.key),
    ).map((definition) => {
      const alias = aliasByCanonical.get(definition.key);
      return {
        key: definition.key,
        value: alias?.value ?? definition.value,
        type: definition.type,
        group: definition.group,
        description: definition.description,
      };
    });

    if (toCreate.length > 0) {
      await prisma.$transaction(
        toCreate.map((setting) => prisma.storeSetting.create({ data: setting })),
      );
    }

    return {
      message:
        toCreate.length > 0
          ? `Created ${toCreate.length} canonical setting(s)`
          : 'All canonical settings already exist',
      created: toCreate.length,
      total: SETTING_DEFINITIONS.length,
    };
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export const adminSettingsRouter = Router();
const svc = new AdminSettingsService();
const adminOnly = [authenticate, requireRole(['ADMIN'])];
const adminGuard = [authenticate, requireRole(['ADMIN', 'STAFF'])];

adminSettingsRouter.get('/', ...adminGuard, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.getSettings();
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});

adminSettingsRouter.put('/', ...adminOnly, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateSettingsSchema.parse(req.body);
    const result = await svc.updateSettings(data);
    sendSuccess(res, 200, result);
  } catch (err) {
    next(err);
  }
});

adminSettingsRouter.post(
  '/seed-defaults',
  ...adminOnly,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await svc.seedDefaults();
      sendSuccess(res, 200, result);
    } catch (err) {
      next(err);
    }
  },
);
