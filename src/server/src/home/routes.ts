import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { errorResponse, homeQuery, homeResponse, toJSON } from '@budgedino/shared';
import { visibleAccountIds } from '../access/visibility.js';
import {
  breakdownFor,
  budgetViews,
  householdSettings,
  periodView,
  resolvePeriod,
} from '../budgets/service.js';
import { HttpError } from '../http/errors.js';
import { listConnectorInfos } from '../sync/routes.js';

/**
 * `GET /home`: budgets (household-wide numbers, identical for every member), the viewer's own spending
 * breakdown (visible accounts only) and connector health (own connectors in full, others' status only).
 *
 * The headline period is monthly for `current`/`previous` and the kind of an explicit key. Budgets of the
 * other kind are evaluated for their own period of that moment (each view carries its `period`).
 */
export function homeRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/home',
    {
      config: { access: 'member' },
      schema: {
        tags: ['home'],
        security: [{ bearer: [] }],
        querystring: homeQuery,
        response: { 200: homeResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      const { db, keyring, registry, now } = app.ctx;
      const dk = await keyring.forHousehold(auth.householdId);
      const settings = await householdSettings(db, auth.householdId);
      const spec = req.query.period;
      const headlineKind = spec.includes('W') ? 'weekly' : 'monthly';
      const period = resolvePeriod(spec, headlineKind, now(), settings.timezone);
      if (!period) throw new HttpError(400, 'invalid_period', 'Unknown period');

      const visible = await visibleAccountIds(db, auth);
      const [budgets, breakdown, sync] = await Promise.all([
        budgetViews(db, dk, auth.householdId, now(), spec, settings),
        breakdownFor(db, dk, visible, auth.householdId, period, settings, now()),
        listConnectorInfos(db, keyring, registry, auth),
      ]);
      return {
        period: { kind: period.kind, ...periodView(period) },
        budgets: budgets.views,
        breakdown: breakdown.breakdown.map((b) => ({ ...b, spent: toJSON(b.spent) })),
        daily: breakdown.daily.map((d) => ({ date: d.date, spent: toJSON(d.spent) })),
        income: toJSON(breakdown.income),
        uncategorizedIncome: toJSON(breakdown.uncategorizedIncome),
        fxMissing: budgets.fxMissing || breakdown.fxMissing,
        sync,
      };
    },
  );
}
