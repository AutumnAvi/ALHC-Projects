// Batch 43 (item 6): an embedded form sizes itself. The embed page (/forms/<id>/embed) posts its content's
// height to the page that frames it; the Share snippet's short script listens for it and sets the frame's
// height, accepting a message only from this app's origin and only from its own frame (event.source), and
// clamping the height. Old snippets (the iframe alone) keep their fixed 900 px.

export const EMBED_HEIGHT_MESSAGE = "alhc:form-height";
export const EMBED_DEFAULT_HEIGHT = 900;
export const EMBED_MIN_HEIGHT = 120;
export const EMBED_MAX_HEIGHT = 6000;

export const EMBED_NOTE =
  "The embed code sizes itself to the form as it grows and shrinks. A page that strips scripts keeps it at a fixed 900 px, like older embed codes.";

export type EmbedHeightMessage = { type: typeof EMBED_HEIGHT_MESSAGE; formId: string; height: number };

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A value for the inline script: JSON, with "<" escaped so nothing in it can close the <script> element.
function scriptValue(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function clampEmbedHeight(height: unknown): number | null {
  const h = Math.round(Number(height));
  if (!Number.isFinite(h) || h <= 0) return null;
  return Math.min(Math.max(h, EMBED_MIN_HEIGHT), EMBED_MAX_HEIGHT);
}

export function formEmbedSnippet(origin: string, formId: string, title: string): string {
  const frameId = `alhc-form-${formId}`;
  const src = `${origin}/forms/${formId}/embed`;
  const script =
    `(function(){var f=document.getElementById(${scriptValue(frameId)});if(!f)return;` +
    `window.addEventListener("message",function(e){` +
    `if(e.origin!==${scriptValue(origin)}||e.source!==f.contentWindow)return;` +
    `var d=e.data;if(!d||d.type!==${scriptValue(EMBED_HEIGHT_MESSAGE)}||d.formId!==${scriptValue(formId)})return;` +
    `var h=Math.round(Number(d.height));if(!isFinite(h)||h<=0)return;` +
    `f.style.height=Math.min(Math.max(h,${EMBED_MIN_HEIGHT}),${EMBED_MAX_HEIGHT})+"px";});})();`;
  return (
    `<iframe id="${attribute(frameId)}" src="${attribute(src)}" title="${attribute(title)}" width="100%" height="${EMBED_DEFAULT_HEIGHT}" style="border:0" loading="lazy"></iframe>\n` +
    `<script>${script}</script>`
  );
}
