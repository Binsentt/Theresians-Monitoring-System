import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import ModalPortal from './ModalPortal';
import { MainContent, PageContent } from './layout/AppLayout';

function Dialogs({ busy = false }) {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  return <MainContent><PageContent>
    <table><tbody><tr><td><button id="open-dialog" onClick={() => setOpen(true)}>Open</button></td></tr></tbody></table>
    {open && <ModalPortal onClose={() => !busy && setOpen(false)}>
      <div className="test-backdrop"><section role="dialog" aria-label="First dialog">
        <input aria-label="First field" />
        <button hidden>Hidden control</button>
        <button disabled>Disabled control</button>
        <button id="open-nested" onClick={() => setNested(true)}>Nested</button>
        <button id="close-dialog" onClick={() => setOpen(false)}>Close</button>
      </section></div>
    </ModalPortal>}
    {nested && <ModalPortal onClose={() => setNested(false)}>
      <div className="test-backdrop"><section role="dialog" aria-label="Nested dialog"><button>Nested field</button></section></div>
    </ModalPortal>}
  </PageContent></MainContent>;
}

describe('shared viewport modal', () => {
  let mount;
  let root;
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    mount = document.createElement('div');
    document.body.appendChild(mount);
    root = createRoot(mount);
  });
  afterEach(() => {
    act(() => root.unmount());
    mount.remove();
  });
  const click = async (element) => {
    element.focus();
    await act(async () => element.click());
  };
  const key = async (keyName, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key: keyName, shiftKey, bubbles: true, cancelable: true });
    await act(async () => document.activeElement.dispatchEvent(event));
    return event;
  };

  test('keeps a nested modal locked until the final close and restores each trigger without moving the page', async () => {
    await act(async () => root.render(<Dialogs />));
    const page = mount.querySelector('.page-content');
    const trigger = mount.querySelector('#open-dialog');
    page.scrollTop = 798;
    await click(trigger);
    const nestedTrigger = document.querySelector('#open-nested');
    await click(nestedTrigger);
    expect(document.querySelectorAll('.viewport-modal-overlay')).toHaveLength(2);
    await key('Escape');
    expect(document.querySelectorAll('.viewport-modal-overlay')).toHaveLength(1);
    expect(page.classList.contains('modal-scroll-locked')).toBe(true);
    expect(document.activeElement).toBe(nestedTrigger);
    await key('Escape');
    expect(document.querySelector('.viewport-modal-overlay')).toBeNull();
    expect(page.classList.contains('modal-scroll-locked')).toBe(false);
    expect(document.body.classList.contains('modal-scroll-locked')).toBe(false);
    expect(page.scrollTop).toBe(798);
    expect(document.activeElement).toBe(trigger);
  });

  test('traps Tab and Shift+Tab, skips hidden controls and blocks focus escaping behind the dialog', async () => {
    await act(async () => root.render(<Dialogs />));
    const trigger = mount.querySelector('#open-dialog');
    await click(trigger);
    const first = document.querySelector('[aria-label="First field"]');
    const last = document.querySelector('#close-dialog');
    expect(document.activeElement).toBe(first);
    await key('Tab', true);
    expect(document.activeElement).toBe(last);
    await key('Tab');
    expect(document.activeElement).toBe(first);
    trigger.focus();
    expect(document.activeElement).toBe(first);
  });

  test('reads the current close guard while preserving native wheel events in tables and dialogs', async () => {
    await act(async () => root.render(<Dialogs busy />));
    const cell = mount.querySelector('td');
    const wheel = (element) => {
      const event = new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    };
    wheel(cell);
    await click(mount.querySelector('#open-dialog'));
    wheel(document.querySelector('[role="dialog"]'));
    await key('Escape');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => root.render(<Dialogs />));
    await key('Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    wheel(cell);
  });

  test.each(['backward wrap', 'forward wrap', 'focus redirection'])('%s lets the browser reveal the focused dialog control', async (movement) => {
    await act(async () => root.render(<Dialogs />));
    const trigger = mount.querySelector('#open-dialog');
    await click(trigger);
    const first = document.querySelector('[aria-label="First field"]');
    const last = document.querySelector('#close-dialog');
    const target = movement === 'backward wrap' ? last : first;
    const focus = jest.spyOn(target, 'focus');
    try {
      if (movement === 'backward wrap') await key('Tab', true);
      else if (movement === 'forward wrap') {
        last.focus();
        await key('Tab');
      } else trigger.focus();
      expect(document.activeElement).toBe(target);
      expect(focus).toHaveBeenCalled();
      // jsdom has no layout: verify that the native focus call may scroll its control into view.
      expect(focus.mock.calls.at(-1)[0]?.preventScroll).not.toBe(true);
    } finally {
      focus.mockRestore();
    }
    const restoreFocus = jest.spyOn(trigger, 'focus');
    try {
      await key('Escape');
      expect(restoreFocus).toHaveBeenLastCalledWith({ preventScroll: true });
    } finally {
      restoreFocus.mockRestore();
    }
  });

  test('constrains every dialog to the padded viewport and leaves scrolling inside its content', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles/modalPortal.css'), 'utf8');
    const overlay = css.match(/\.viewport-modal-overlay\.viewport-modal-overlay\s*\{([^}]*)\}/s)[1];
    const dialog = css.match(/\.viewport-modal-overlay > \[role='dialog'\]\s*\{([^}]*)\}/s)[1];
    expect(overlay).toContain('position: fixed');
    expect(overlay).toContain('inset: 0');
    expect(overlay).toContain('height: 100dvh');
    expect(overlay).toContain('box-sizing: border-box');
    expect(overlay).toContain('place-items: center');
    expect(overlay).toContain('overflow: hidden');
    expect(dialog).toContain('max-height: 100%');
    expect(dialog).toContain('min-height: 0');
    expect(dialog).toContain('overflow-y: auto');
    expect(dialog).toContain('overscroll-behavior: contain');
  });
});
