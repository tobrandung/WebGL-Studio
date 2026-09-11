import release from '@/widget-release.json';

/**
 * The widget bundle URL baked into generated embed snippets.
 *
 * Written by `npm run publish:widget`, which uploads the built IIFE under
 * `w/<version>-<hash>/web3d-widget.iife.js`. Two properties follow from that
 * path being content-addressed: an embed already live on a customer site keeps
 * pointing at the exact bundle it was generated against, and a new publish can
 * never invalidate it. Previously this was a jsDelivr path against a manually
 * committed file, so "deploy the widget" and "break older embeds" were the same
 * action.
 */
export type WidgetRelease = {
  url: string | null;
  version: string | null;
  publishedAt: string | null;
};

export function widgetRelease(): WidgetRelease {
  return release as WidgetRelease;
}

/** Null until the widget has been published at least once. */
export function widgetScriptUrl(): string | null {
  return widgetRelease().url;
}
