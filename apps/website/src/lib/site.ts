import zh from '../i18n/zh-CN.json';
import en from '../i18n/en.json';
export type Locale='zh-CN'|'en';
export const origin='https://hetu.limeai.run';
export const source='https://github.com/limecloud/hetu';
export const prototype=(locale:Locale)=>'/prototype/workbench.html'+(locale==='en'?'?lang=en':'');
export const messages=(locale:Locale)=>locale==='en'?en:zh;
export const route=(locale:Locale,page='')=>`${locale==='en'?'/en':'/'}${locale==='en'?'/':''}${page?`${page}/`:''}`;
export const pages=['','workflow','integrations','faq','docs','brand'] as const;
