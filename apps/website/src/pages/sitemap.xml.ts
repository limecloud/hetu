import { origin, pages, route } from '../lib/site';
import { docs, groups, sectionPath } from '../lib/docs';
import { articles } from '../lib/journal';
import { plugins } from '../lib/plugins';
export function GET() {
  const urls = (['zh-CN', 'en'] as const).flatMap(locale => [...pages, ...plugins.map(plugin => `plugins/${plugin.slug}`), ...groups.map(group => sectionPath(group.id)), ...docs.map(doc => `docs/${doc.id}`), ...articles.map(article => `blog/${article.id}`)].map(page => new URL(route(locale, page), origin).href));
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
