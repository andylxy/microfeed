import type {PageNavigationEntry} from "@/shared/Pages";
import {navigationPages} from "@/server/pages/service";
import {listCategoryNav} from "@/server/feed/extCategory";
import type {Category, CategoryDb} from "@/server/feed/extCategory";

/** A category nav entry plus whether it is the page currently being viewed. */
export interface SiteNavCategory extends Category {
  active: boolean;
}

export interface SiteNavContext {
  navigation_pages: PageNavigationEntry[];
  category_nav: SiteNavCategory[];
  nav_active_home: boolean;
}

/**
 * Context for the site header, which the active theme renders from its
 * `webBodyStart` template. The header appears on every public page, so each
 * route must hand this into its `Theme` instance; a route that forgets it
 * renders an empty category nav instead of failing loudly.
 *
 * `activeNav` is `"home"` on the landing page, a category id (or a legacy slug)
 * on a category page, and `""` everywhere else (book detail, reader, search,
 * custom pages).
 * It only drives the active-link styling, never which links are listed.
 */
export async function loadSiteNav(
  database: D1Database,
  request: Request,
  activeNav = "",
): Promise<SiteNavContext> {
  const [navigation_pages, categories] = await Promise.all([
    navigationPages(database, request),
    listCategoryNav(database as unknown as CategoryDb),
  ]);
  return {
    navigation_pages,
    category_nav: categories.map((category) => ({
      ...category,
      active: category.id === activeNav || category.slug === activeNav,
    })),
    nav_active_home: activeNav === "home",
  };
}
