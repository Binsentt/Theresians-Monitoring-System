import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PageContent } from './AppLayout';

test('PageContent uses the shared content-transition wrapper', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(<PageContent>Page body</PageContent>);
  });

  const content = container.querySelector('.page-content');
  expect(content.classList.contains('page-content-transition')).toBe(true);
  expect(content.textContent).toBe('Page body');
  await act(async () => {
    root.unmount();
  });
  delete global.IS_REACT_ACT_ENVIRONMENT;
});
