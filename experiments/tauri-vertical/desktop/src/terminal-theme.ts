import type { ITheme } from '@xterm/xterm';

// Native Claude reference: quiet charcoal, blue-gray, readable semantic ANSI.
// These map palette slots only; provider truecolor and SGR remain untouched.
export const terminalTheme: ITheme = {
  background: '#292f3a',
  foreground: '#e9edf3',
  cursor: '#f0b323',
  cursorAccent: '#292f3a',
  selectionBackground: '#465369',
  selectionInactiveBackground: '#3c4655',
  selectionForeground: '#ffffff',
  black: '#202630',
  red: '#d98b8b',
  green: '#a2bc98',
  yellow: '#d7bb7b',
  blue: '#89add0',
  magenta: '#b6a0c8',
  cyan: '#91bfc5',
  white: '#c8ced8',
  brightBlack: '#8e99a8',
  brightRed: '#e9a3a3',
  brightGreen: '#b6cda9',
  brightYellow: '#e4ca91',
  brightBlue: '#a2c3e3',
  brightMagenta: '#ccb6dd',
  brightCyan: '#abd3d8',
  brightWhite: '#f1f3f6',
};

export const terminalFontFamily = '"JetBrains Mono", Menlo, Monaco, "SFMono-Regular", monospace';
export const terminalFontWeight = 500 as const;
export const terminalFontWeightBold = 700 as const;
// Keep SGR bold, without turning the normal ANSI slot into its bright sibling.
export const terminalDrawBoldTextInBrightColors = false;

export const terminalTypography = {
  fontFamily: terminalFontFamily,
  fontWeight: terminalFontWeight,
  fontWeightBold: terminalFontWeightBold,
  drawBoldTextInBrightColors: terminalDrawBoldTextInBrightColors,
} as const;
