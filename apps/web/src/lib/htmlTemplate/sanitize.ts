import DOMPurify from 'dompurify';

import {REGION_ATTR} from './types';

/**
 * Sanitizes markup on its way into the preview iframe.
 *
 * Applied only to what is RENDERED, never to what is stored: the stored template
 * stays byte-identical to what was imported, and stripping a `<script>` here must
 * not silently rewrite the user's file. Templates routinely arrive from an
 * exporter or a customer's designer, so the rendered copy is treated as untrusted.
 *
 * `WHOLE_DOCUMENT` keeps `<html>`/`<head>`/`<style>` intact — an email template is
 * a complete document, and dropping its head would discard every style rule it
 * depends on.
 */
export function sanitizeForRender(html: string): string {
  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    // The markers click-to-edit routes on; DOMPurify strips unknown data-*
    // attributes under some configs, and losing these silently disables editing.
    ADD_ATTR: Object.values(REGION_ATTR),
  });
}
