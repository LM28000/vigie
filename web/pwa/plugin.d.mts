import type { Plugin } from 'vite';

export function shellFiles(fileNames: string[]): string[];
export function shellVersion(files: string[], indexHtml: string): string;
export function renderServiceWorker(template: string, files: string[], version: string): string;
export function serviceWorker(): Plugin;
