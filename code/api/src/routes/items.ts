import { ItemSchema } from '@app/shared';
import { Router } from 'express';
import { cache } from '../cache.js';
import { db } from '../db.js';
import { HttpError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';
import { createItem, getItem, listItems } from '../repo/items.js';

// Request schemas — derived from the shared ItemSchema (the single source of
// truth for the item shape, shared with the hydrator via @app/shared).
const ItemParams = ItemSchema.pick({ id: true });
const CreateItemBody = ItemSchema.omit({ id: true });

export const itemsRouter: Router = Router();

itemsRouter.get('/items', async (_req, res) => {
  res.json(await listItems(db));
});

itemsRouter.get('/items/:id', validate({ params: ItemParams }), async (req, res) => {
  const item = await getItem(db, cache, Number(req.params.id));
  if (!item) throw new HttpError(404, `Item ${req.params.id} not found`);
  res.json(item);
});

itemsRouter.post('/items', validate({ body: CreateItemBody }), async (req, res) => {
  const item = await createItem(db, req.body.name);
  res.status(201).json(item);
});
