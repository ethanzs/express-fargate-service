import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errorHandler.js';
import { validate } from '../middleware/validate.js';

/**
 * Example REST resource backed by an in-memory store.
 * Swap the store for a real database/repository layer when you add persistence.
 */
interface Item {
  id: number;
  name: string;
}

const items: Item[] = [
  { id: 1, name: 'first' },
  { id: 2, name: 'second' },
];
let nextId = 3;

// Request schemas — the single source of truth for shape + validation.
const ItemParams = z.object({
  id: z.coerce.number().int().positive(),
});
const CreateItemBody = z.object({
  name: z.string().trim().min(1).max(100),
});

export const itemsRouter: Router = Router();

itemsRouter.get('/items', (_req, res) => {
  res.json(items);
});

itemsRouter.get('/items/:id', validate({ params: ItemParams }), (req, res) => {
  const id = Number(req.params.id);
  const item = items.find((i) => i.id === id);
  if (!item) throw new HttpError(404, `Item ${req.params.id} not found`);
  res.json(item);
});

itemsRouter.post('/items', validate({ body: CreateItemBody }), (req, res) => {
  const item: Item = { id: nextId++, name: req.body.name };
  items.push(item);
  res.status(201).json(item);
});