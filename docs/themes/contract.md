---
title: Theme contract and rendering
description: Understand the manifest, render slots, Mustache context, Pages, navigation, retired search compatibility, schemas, fixtures, and package limits.
---

The generated schemas in each theme repository are the exact contract for its
manifest and render context. Read them before editing templates or generating
theme code.

## Format versions and slots

Format v1 themes have six slots and remain compatible with feed and item
pages. Format v2 adds standalone Pages for a seventh renderable slot;
`webSearch` is still accepted from existing packages but has no renderer since
public search was retired (ADR-0051, migration 0151):

| Slot | Purpose |
| --- | --- |
| `webFeed` | Render the public feed home page. |
| `webItem` | Render one item page. |
| `webPage` | Render a standalone Page, including the editable default 404 Page. |
| `webSearch` | Accepted and validated for backward compatibility; never rendered. |
| `webHeader` | Insert markup before `</head>`. |
| `webBodyStart` | Insert markup immediately after `<body>`. |
| `webBodyEnd` | Insert markup immediately before `</body>`. |
| `rssStylesheet` | Provide the complete RSS XSL stylesheet. |

An active format v1 theme prevents a Page from becoming Published or Unlisted.
It does not block Page drafts. Use format v2 for Pages and navigation.

## Manifest and render context

`microfeed-theme.json` declares package identity, semantic version, compatible
microfeed versions, the theme file paths, and optional assets. Its optional
`description` is a short, public summary of what the theme is good for and is
limited to 280 characters. One package ID and version identifies one immutable
set of content.

A theme may also declare one `previewFixture`, such as
`fixtures/editorial.json`. The value must be a safe relative path to a UTF-8
JSON object no larger than 128 KiB. Admin uses this theme-specific fixture as
the default demo dataset while still allowing the owner to switch to the
current site's published content. A declared fixture is stored independently
from templates and assets, participates in the immutable package checksum, and
survives installation, Admin-derived drafts, publication, `theme init`, and
`theme export`. Admin drafts inherit it but cannot edit it. Themes without a
declared fixture continue previewing current-site data.

A format v2 manifest may also declare `searchItemDestination`, kept for
backward compatibility with packages written while public search existed. The
live site no longer has a search surface to consume it; `theme-kit` preview and
the theme editor still read it, so the field stays valid:

| Value | Item destination and feed field |
| --- | --- |
| `web` | The local microfeed item page from JSON Feed `items[]._microfeed.web_url`. RSS uses it as `<item><link>` only when Item URL is empty. |
| `url` | The custom Item URL from JSON Feed `items[].url` and RSS `<item><link>`. |
| `attachment` | The media attachment from JSON Feed `items[].attachments[0].url` and RSS `<item><enclosure url="…">`. |

Omission is equivalent to `web`. When the selected custom value is missing,
microfeed falls back to the local item page; Page results always keep their
local Page URL.

The render context begins with the public JSON Feed and adds:

- `current_year`;
- `_theme.package_id`;
- `_theme.version`;
- `_theme.asset_base_url`;
- `navigation_pages` on public HTML views; and
- `page` on the Page slot.

`search` is preview-only. `theme-kit` still builds it from the fixture so a
package's `webSearch` template can be rendered offline, but no live route ever
produces it.

On item pages, use `items.0`. The `item` alias remains available only for
compatibility with older themes.

Mustache remains logicless: variables, escaped and unescaped values, sections,
inverted sections, and iteration are supported. Owner-authored rich HTML such
as item or Page `content_html` is intended for triple-brace rendering. Escape
ordinary text and attributes by default.

## Render Pages and navigation

`navigation_pages` contains Published Pages whose **Show in navigation**
setting is enabled, in the order selected in Admin. Draft, Unlisted, and the
special 404 Page are excluded. Navigation is website-only and never adds a
Page to RSS or JSON Feed.

Render the same navigation in feed, item, and Page templates:

```html
<nav aria-label="Site navigation">
  {{#navigation_pages}}
    <a href="{{url}}">{{navigation_label}}</a>
  {{/navigation_pages}}
</nav>
```

The `webPage` slot also renders the protected default 404 Page. Check
`page.is_not_found_page` only when the theme needs distinct 404 styling; the
ordinary Page structure should otherwise work unchanged.

## Public search was retired

Site-wide public search is gone (ADR-0051, migration 0151). There is no
`/search/` route and no `/search.json`: requests to those paths land on the 404
Page. Admin search is unaffected and does not involve themes.

Two pieces of the theme contract survive only as compatibility surface:

- `webSearch` in `theme.json` is still accepted and validated so that packages
  written while public search existed keep installing. The slot has no renderer
  and its template is never executed.
- `searchItemDestination` in a format v2 manifest is still read by `theme-kit`
  preview and the theme editor, so the field stays valid, but no live surface
  consumes it.

A theme should therefore not ship a search form, a `data-microfeed-search-open`
control, or any `mf-public-search*` styling. The `data-microfeed-search-*`
hooks and `--mf-search-result-domain-display` token are inert.

Styles and scripts that reference those hooks are harmless but dead; new themes
should omit them entirely.

## Schemas, fixtures, and package limits

A generated repository includes JSON Schemas under `.microfeed/schemas/`, a
representative package fixture, and built-in test fixtures for empty, minimal,
rich, paginated, media-heavy, missing-optional, multi-author, and hostile-rich-
HTML content.

Package limits are:

- 128 KiB per text slot;
- 512 KiB total theme text;
- 128 KiB for the optional declared preview fixture;
- 100 declared assets;
- 5 MiB per asset; and
- 20 MiB total assets.

Validation rejects absolute paths, traversal, symlinks, missing or malformed
declared preview fixtures, undeclared files, malformed Mustache, invalid
semantic versions, incompatible microfeed ranges, and unsupported asset types.
Tests check deterministic rendering, HTML structure, and valid RSS XSL; themes
are trusted code, so they do not sanitize intentional HTML or JavaScript.

Continue with [Bundle CSS, JavaScript, and assets](/themes/assets/) or return to
[Build and release a theme](/themes/).
