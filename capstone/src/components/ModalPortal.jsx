import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import '../styles/modalPortal.css';

const openModals = [];
let restoreScrolling;

const focusableElements = (dialog) => Array.from(dialog.querySelectorAll(
  'a[href], button, input, select, textarea, [tabindex]',
)).filter((element) => (
  element.tabIndex >= 0
  && !element.matches(':disabled')
  && !element.closest('[hidden], [inert]')
  && getComputedStyle(element).display !== 'none'
  && getComputedStyle(element).visibility !== 'hidden'
));

const lockScrolling = () => {
  const elements = [document.documentElement, document.body, ...document.querySelectorAll('.page-content, .analytics-sidebar-panel')];
  const saved = elements.map((element) => ({
    element,
    top: element.scrollTop,
    left: element.scrollLeft,
    alreadyLocked: element.classList.contains('modal-scroll-locked'),
  }));
  elements.forEach((element) => element.classList.add('modal-scroll-locked'));
  return () => saved.forEach(({ element, top, left, alreadyLocked }) => {
    if (!alreadyLocked) element.classList.remove('modal-scroll-locked');
    element.scrollTop = top;
    element.scrollLeft = left;
  });
};

// Keep the existing overlay and dialog markup, but place it outside page transforms.
export default function ModalPortal({ children, onClose }) {
  const overlayRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const dialog = overlay.querySelector('[role="dialog"]');
    const previousFocus = document.activeElement;
    if (openModals.length === 0) restoreScrolling = lockScrolling();
    openModals.push(overlay);
    overlay.style.zIndex = String(2000 + openModals.length);
    const isTopModal = () => openModals[openModals.length - 1] === overlay;
    const focusStart = () => (focusableElements(dialog)[0] || dialog).focus();
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    focusStart();

    const onKeyDown = (event) => {
      if (!isTopModal()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current?.();
      } else if (event.key === 'Tab') {
        const focusable = focusableElements(dialog);
        const first = focusable[0] || dialog;
        const last = focusable[focusable.length - 1] || dialog;
        if (!dialog.contains(document.activeElement) || document.activeElement === dialog
          || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    const onFocusIn = (event) => {
      if (isTopModal() && !dialog.contains(event.target)) focusStart();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      const wasTopModal = isTopModal();
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      openModals.splice(openModals.indexOf(overlay), 1);
      if (openModals.length === 0) {
        restoreScrolling?.();
        restoreScrolling = undefined;
      }
      if (wasTopModal && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(React.cloneElement(children, {
    ref: overlayRef,
    className: `${children.props.className || ''} viewport-modal-overlay`.trim(),
  }), document.body);
}
