/**
 * Jest tests for GET/PUT/POST /api/crawler-recipes
 *
 * Strategy:
 *   - Mock 'pg' Pool so no real DB is needed
 *   - Mount only the crawler-recipes router with minimal middleware
 *   - Test: list, get one, 404, upsert increments version, activate/deactivate
 *   - Auth/role middleware is bypassed via a test stub (tested separately)
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import 'express-async-errors';

// ── Mock pg pool ──────────────────────────────────────────────────────────────
const mockQuery = jest.fn();
jest.mock('../../src/db/pool', () => ({
  pool: { query: mockQuery },
}));

// ── Stub auth middleware so test doesn't need real JWT ────────────────────────
jest.mock('../../src/middleware/auth', () => ({
  authenticate: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole:  (..._roles: string[]) =>
    (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Import router AFTER mocks are set up
import crawlerRecipesRouter from '../../src/routes/crawler-recipes';
import { errorHandler, notFoundHandler } from '../../src/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/api/crawler-recipes', crawlerRecipesRouter);
app.use(notFoundHandler);
app.use(errorHandler);

// ── Fixtures ──────────────────────────────────────────────────────────────────
const RECIPE_ROW = {
  id:         'aaaaaaaa-0000-0000-0000-000000000001',
  name:       'gdt_main',
  version:    1,
  is_active:  true,
  recipe:     { api: { baseUrl: 'https://hoadondientu.gdt.gov.vn:30000' } },
  notes:      'Default recipe',
  updated_at: '2026-04-01T00:00:00.000Z',
  updated_by: null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ── GET / ─────────────────────────────────────────────────────────────────────

describe('GET /api/crawler-recipes', () => {
  it('returns list of recipes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [RECIPE_ROW] });

    const res = await request(app).get('/api/crawler-recipes');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('gdt_main');
  });

  it('returns empty array when no recipes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/crawler-recipes');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ── GET /:name ────────────────────────────────────────────────────────────────

describe('GET /api/crawler-recipes/:name', () => {
  it('returns a single recipe by name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [RECIPE_ROW] });

    const res = await request(app).get('/api/crawler-recipes/gdt_main');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('gdt_main');
    expect(res.body.data.version).toBe(1);
  });

  it('returns 404 for unknown recipe name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/crawler-recipes/does_not_exist');

    expect(res.status).toBe(404);
    expect(res.body.success).toBeFalsy();
  });
});

// ── PUT /:name ────────────────────────────────────────────────────────────────

describe('PUT /api/crawler-recipes/:name', () => {
  const updatedRow = { ...RECIPE_ROW, version: 2, updated_by: 'admin@test.com' };

  it('upserts recipe and returns updated row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [updatedRow] });

    const res = await request(app)
      .put('/api/crawler-recipes/gdt_main')
      .send({ recipe: { api: { baseUrl: 'https://new.gdt.gov.vn' } }, notes: 'Test save' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toBe(2);

    // Verify parameterized query was used (not string interpolation)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('$1'),
      expect.arrayContaining(['gdt_main']),
    );
  });

  it('returns 400 when recipe field is missing', async () => {
    const res = await request(app)
      .put('/api/crawler-recipes/gdt_main')
      .send({ notes: 'no recipe key' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBeFalsy();
    // pool.query must NOT have been called — validation failed before DB
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects non-object recipe field', async () => {
    const res = await request(app)
      .put('/api/crawler-recipes/gdt_main')
      .send({ recipe: 'not an object' });

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── POST /:name/activate ──────────────────────────────────────────────────────

describe('POST /api/crawler-recipes/:name/activate', () => {
  it('activates a recipe', async () => {
    const activeRow = { ...RECIPE_ROW, is_active: true };
    mockQuery.mockResolvedValueOnce({ rows: [activeRow] });

    const res = await request(app)
      .post('/api/crawler-recipes/gdt_main/activate')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.is_active).toBe(true);
  });

  it('returns 404 when recipe not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/crawler-recipes/no_such_recipe/activate')
      .send({});

    expect(res.status).toBe(404);
  });
});

// ── POST /:name/deactivate ────────────────────────────────────────────────────

describe('POST /api/crawler-recipes/:name/deactivate', () => {
  it('deactivates a recipe', async () => {
    const inactiveRow = { ...RECIPE_ROW, is_active: false };
    mockQuery.mockResolvedValueOnce({ rows: [inactiveRow] });

    const res = await request(app)
      .post('/api/crawler-recipes/gdt_main/deactivate')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.is_active).toBe(false);
  });

  it('returns 404 when recipe not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/crawler-recipes/no_such_recipe/deactivate')
      .send({});

    expect(res.status).toBe(404);
  });
});

// ── Security: no SQL injection via recipe name ────────────────────────────────

describe('Security — parameterized queries', () => {
  it('passes recipe name as query parameter, not interpolated', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [RECIPE_ROW] });
    await request(app).get("/api/crawler-recipes/gdt_main'; DROP TABLE crawler_recipes;--");
    // The query must still be called with the raw name as a $1 parameter
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('$1'),
      expect.any(Array),
    );
  });
});
