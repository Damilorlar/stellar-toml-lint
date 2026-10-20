/**
 * The popup: what the badge cannot say.
 *
 * A badge can hold a digit; an engineer wants to know which anchor this is,
 * what it lists, and what it got wrong. All of that is already in the summary
 * the service worker cached, so this file is rendering and nothing else.
 */
import { infoFileUrl } from './origin.js';
import { MESSAGE_INSPECT, MESSAGE_REFRESH, type InspectResponse } from './messages.js';

const root = document.getElementById('popup-root');

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(response: InspectResponse): void {
  if (root === null) return;
  root.innerHTML = '';

  const host = response.origin === undefined ? undefined : new URL(response.origin).hostname;
  root.append(el('h1', 'popup__host', host ?? 'No site to inspect'));

  if (response.error !== undefined || response.summary === undefined) {
    root.append(
      el(
        'p',
        'popup__error',
        response.error ?? 'Nothing was inspected. Open an https anchor site and try again.',
      ),
    );
    if (response.origin !== undefined) {
      root.append(link('Open the info file', infoFileUrl(response.origin)));
    }
    return;
  }

  const summary = response.summary;
  const verdict = summary.ok ? 'Valid' : 'Has errors';
  root.append(
    el(
      'p',
      `popup__verdict popup__verdict--${summary.ok ? 'ok' : 'bad'}`,
      `${verdict} · ${summary.counts.error} error(s), ${summary.counts.warning} warning(s)`,
    ),
  );

  if (summary.orgName !== undefined) {
    root.append(el('h2', 'popup__org', summary.orgName));
  }
  if (summary.orgDescription !== undefined) {
    root.append(el('p', 'popup__description', summary.orgDescription));
  }
  if (summary.orgUrl !== undefined) {
    root.append(link(summary.orgUrl, summary.orgUrl));
  }

  if (summary.assets.length === 0) {
    root.append(el('p', 'popup__muted', 'No assets listed.'));
  } else {
    root.append(el('h2', 'popup__section', `Assets (${summary.assets.length})`));
    const chips = el('ul', 'popup__assets');
    for (const asset of summary.assets) {
      const chip = el('li', asset.regulated ? 'chip chip--regulated' : 'chip', asset.code);
      chip.title =
        asset.issuer === undefined
          ? asset.code
          : `${asset.code} issued by ${asset.issuer}${asset.regulated ? ' (regulated)' : ''}`;
      chips.append(chip);
    }
    root.append(chips);
  }

  if (summary.findings.length === 0) {
    root.append(el('p', 'popup__muted', 'No SEP-1 issues found.'));
  } else {
    root.append(el('h2', 'popup__section', `Findings (${summary.findings.length})`));
    const list = el('ul', 'popup__findings');
    for (const finding of summary.findings) {
      const item = el('li', `popup__finding popup__finding--${finding.severity}`);
      const where = finding.line === undefined ? '' : `${finding.line}: `;
      item.append(
        el('code', undefined, `${where}${finding.rule}`),
        el('span', undefined, finding.message),
      );
      list.append(item);
    }
    root.append(list);
  }

  const footer = el('div', 'popup__footer');
  if (response.origin !== undefined) {
    footer.append(link('Info file', infoFileUrl(response.origin)));
  }
  const recheck = el('button', 'popup__recheck', 'Re-check');
  recheck.type = 'button';
  recheck.addEventListener('click', () => {
    void load(true);
  });
  footer.append(recheck);
  root.append(footer);
}

function link(text: string, href: string): HTMLAnchorElement {
  const anchor = el('a', 'popup__link', text);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer noopener';
  return anchor;
}

async function load(force: boolean): Promise<void> {
  if (root === null) return;
  root.innerHTML = '';
  root.append(el('p', 'popup__loading', 'Inspecting this site…'));
  try {
    const response = (await chrome.runtime.sendMessage({
      type: force ? MESSAGE_REFRESH : MESSAGE_INSPECT,
    })) as InspectResponse;
    render(response ?? { error: 'The background worker did not answer.' });
  } catch (error) {
    render({ error: error instanceof Error ? error.message : String(error) });
  }
}

void load(false);
