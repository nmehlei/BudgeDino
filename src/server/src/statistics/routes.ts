import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { errorResponse, statisticsQuery, statisticsResponse, toJSON } from '@budgedino/shared';
import { visibleAccountIds } from '../access/visibility.js';
import { householdSettings, statisticsFor } from '../budgets/service.js';

/** `GET /statistics?months=6|12`: monthly income/spending and category comparison over the viewer's visible accounts. */
export function statisticsRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/statistics',
    {
      config: { access: 'member' },
      schema: {
        tags: ['statistics'],
        security: [{ bearer: [] }],
        querystring: statisticsQuery,
        response: { 200: statisticsResponse, '4xx': errorResponse },
      },
    },
    async (req) => {
      const auth = req.auth;
      if (!auth) throw new Error('unreachable: the access hook authenticates');
      const { db, keyring, now } = app.ctx;
      const dk = await keyring.forHousehold(auth.householdId);
      const settings = await householdSettings(db, auth.householdId);
      const visible = await visibleAccountIds(db, auth);
      const s = await statisticsFor(
        db,
        dk,
        visible,
        auth.householdId,
        req.query.months,
        settings,
        now(),
      );
      return {
        months: s.months.map((m) => ({
          ...m,
          income: toJSON(m.income),
          spending: toJSON(m.spending),
        })),
        averageKept: s.averageKept ? toJSON(s.averageKept) : null,
        categories: s.categories.map((c) => ({
          ...c,
          spent: toJSON(c.spent),
          previousSpent: toJSON(c.previousSpent),
        })),
        fxMissing: s.fxMissing,
      };
    },
  );
}
