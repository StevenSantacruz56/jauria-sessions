/** Static checks of the 1.4 visual system. Reads only versioned source files. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
const sheets = ['style.css', 'pulso-panel.css', 'settings-panel.css', 'telemetry.css', 'codex-conversation.css'];
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const block = (css: string, selector: string) => {
  const start = css.indexOf(selector); assert.notEqual(start, -1, selector);
  const open = css.indexOf('{', start); const close = css.indexOf('}', open);
  return css.slice(open + 1, close).split(';').map(line => line.trim()).filter(Boolean);
};

test('the system-dark and explicit-dark token blocks are identical and cover every light token', async () => {
  const css = stripComments(await source('style.css'));
  const system = block(css, ':root:not([data-theme="light"]) {');
  const explicit = block(css, ':root[data-theme="dark"] {');
  assert.deepEqual(explicit, system);
  const names = (lines: string[]) => lines.filter(line => line.startsWith('--')).map(line => line.split(':')[0]).sort();
  const light = names(block(css, ':root {').filter(line => line.startsWith('--')));
  assert.deepEqual(names(system), light, 'each appearance token has a dark value');
  for (const token of ['--state-working', '--state-attention', '--state-ready', '--state-paused', '--focus', '--dim']) assert.ok(light.includes(token), token);
});

test('amber is reserved for the primary action', async () => {
  for (const name of sheets) {
    const css = stripComments(await source(name));
    // Amber literals may only define the --brand* tokens.
    for (const line of css.split(/[;{}]/)) if (/#f0b323|#dca21c|#c89216|#8a5f00/i.test(line)) assert.match(line.trim(), /^--brand(?:-hover|-active|-text)?:/, `${name}: ${line.trim()}`);
    if (name !== 'style.css') assert.doesNotMatch(css, /--brand/, `${name} must not use brand amber`);
    for (const rule of css.split('}')) {
      if (/var\(--brand(?:-hover|-active)?\)/.test(rule)) assert.match(rule.trim(), /^\.primary/, `${name}: ${rule.trim().slice(0, 80)}`);
    }
  }
});

test('the terminal background is the same in CSS and in the xterm theme', async () => {
  const css = await source('style.css'); const theme = await source('terminal-theme.ts');
  const token = css.match(/--terminal:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.equal(token, '#16191d');
  assert.match(theme, new RegExp(`background: '${token}'`));
  assert.match(theme, new RegExp(`cursorAccent: '${token}'`));
});

test('type, weight and radius stay on the 1.4 scale', async () => {
  for (const name of sheets) {
    const css = stripComments(await source(name));
    for (const [, size] of css.matchAll(/font-size:\s*([0-9.]+)px/g)) assert.ok(['11', '12', '13', '16', '20'].includes(size), `${name}: font-size ${size}px`);
    for (const [, size] of css.matchAll(/font:\s*(?:[0-9]{3}\s+)?([0-9.]+)px/g)) assert.ok(['11', '12', '13'].includes(size), `${name}: font ${size}px`);
    for (const [, weight] of css.matchAll(/font-weight:\s*([0-9]+)/g)) assert.ok(['400', '500', '600'].includes(weight) || (name === 'style.css' && ['700', '800'].includes(weight)), `${name}: weight ${weight}`);
    for (const [, radius] of css.matchAll(/border-radius:\s*([0-9.]+)px/g)) assert.ok(['0', '6', '8', '10', '7', '999'].includes(radius), `${name}: radius ${radius}px`);
  }
});

const luminance = (hex: string) => {
  const channel = (i: number) => { const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('the dark sidebar is the logo ink, and dim/muted text stays AA on it', async () => {
  const css = stripComments(await source('style.css'));
  const value = (lines: string[], name: string) => lines.find(line => line.startsWith(`${name}:`))!.split(':')[1].trim();
  const dark = block(css, ':root[data-theme="dark"] {');
  // The dark horizontal logo ships with a #0E1116 background rect; the sidebar matches it.
  assert.equal(value(dark, '--sidebar').toLowerCase(), '#0e1116');
  for (const token of ['--dim', '--muted', '--text']) assert.ok(contrast(value(dark, token), '#0e1116') >= 4.5, `${token} on the dark sidebar`);
  const light = block(css, ':root {');
  for (const token of ['--dim', '--muted', '--text']) assert.ok(contrast(value(light, token), value(light, '--sidebar')) >= 4.5, `${token} on the light sidebar`);
});

test('status chrome has fixed heights and never wraps (status changes must never resize a PTY)', async () => {
  const css = stripComments(await source('style.css'));
  const rule = (selector: string) => block(css, `${selector} {`).join(';');
  for (const [selector, height] of [['.workbench-header', '42px'], ['.pane-heading', '32px'], ['.workbench-footer', '28px']]) {
    const body = rule(selector);
    assert.match(body, new RegExp(`(?:^|;)height: ${height}`), `${selector} height`);
    assert.match(body, new RegExp(`min-height: ${height}`), `${selector} min-height`);
    assert.match(body, /white-space: nowrap/, `${selector} nowrap`);
  }
  assert.match(rule('.pane-heading'), /max-height: 32px/);
  assert.match(rule('.pane-heading'), /overflow: hidden/);
  // Not positioned: the floating menu anchors to the pane and is not clipped by the heading.
  assert.doesNotMatch(rule('.pane-heading'), /position:/);
  // Popover, picker and notice float; none of them is in the flow above the terminal.
  for (const selector of ['.alerts-popover', '.session-picker', '.notice', '.pane-menu-content']) assert.match(rule(selector), /position: absolute/, selector);
  assert.doesNotMatch(css, /\.workbench-messages/, 'no message rail');
  // Pane focus changes color and a ring, never border width.
  assert.doesNotMatch(rule('.pane.is-focused'), /border-width|border:/);
});
