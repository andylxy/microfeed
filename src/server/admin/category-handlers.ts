import {z} from "zod";

import {AppError} from "@/shared/errors";
import type {
  Category,
  CategoryDb,
  CategoryInput,
} from "@/server/feed/extCategory";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  reorderCategories,
  updateCategory,
} from "@/server/feed/extCategory";

const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().min(1).max(11).nullable().optional(),
  slug: z.string().trim().min(1).max(120).optional(),
  sort: z.number().int().min(0).max(100000).optional(),
  visible: z.boolean().optional(),
});

const categoryUpdateSchema = categoryCreateSchema.partial();

const categoryOrderSchema = z.object({
  ids: z.array(z.string().min(1).max(11)).min(1).max(200),
});

export const CATEGORY_ERRORS = {
  notFound: "errors.category.notFound",
} as const;

export async function listCategoriesHandler(db: CategoryDb): Promise<Category[]> {
  return listCategories(db);
}

export async function createCategoryHandler(
  db: CategoryDb,
  body: unknown,
): Promise<Category> {
  const parsed = categoryCreateSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("errors.category.invalidInput", 400);
  }
  const input: CategoryInput = {
    name: parsed.data.name,
    ...(parsed.data.parentId !== undefined ? {parentId: parsed.data.parentId} : {}),
    ...(parsed.data.slug !== undefined ? {slug: parsed.data.slug} : {}),
    ...(parsed.data.sort !== undefined ? {sort: parsed.data.sort} : {}),
    ...(parsed.data.visible !== undefined ? {visible: parsed.data.visible} : {}),
  };
  return createCategory(db, input);
}

export async function getCategoryHandler(
  db: CategoryDb,
  id: string,
): Promise<Category> {
  const category = await getCategory(db, id);
  if (!category) throw new AppError(CATEGORY_ERRORS.notFound, 404);
  return category;
}

export async function updateCategoryHandler(
  db: CategoryDb,
  id: string,
  body: unknown,
): Promise<Category> {
  const parsed = categoryUpdateSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("errors.category.invalidInput", 400);
  }
  const updated = await updateCategory(db, id, parsed.data);
  if (!updated) throw new AppError(CATEGORY_ERRORS.notFound, 404);
  return updated;
}

export async function deleteCategoryHandler(
  db: CategoryDb,
  id: string,
): Promise<void> {
  const ok = await deleteCategory(db, id);
  if (!ok) throw new AppError(CATEGORY_ERRORS.notFound, 404);
}

export async function reorderCategoriesHandler(
  db: CategoryDb,
  body: unknown,
): Promise<void> {
  const parsed = categoryOrderSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("errors.category.invalidOrder", 400);
  }
  await reorderCategories(db, parsed.data.ids);
}
