import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiProvider } from '../api/ApiContext';
import { createApi } from '../api/client';
import { BASE, config } from '../test/harness';
import { Avatar, PhotoGrid } from './Photos';

const LABEL = 'Photos from your pro';
const NAME = 'Daniel';

function renderGrid(ids = ['p1', 'p2', 'p3']) {
  return render(
    <ApiProvider api={createApi(BASE)} config={config}>
      <PhotoGrid ids={ids} label={LABEL} />
    </ApiProvider>,
  );
}

const shown = () => screen.getByRole('dialog');

describe('photos full screen (D83)', () => {
  it('opens the tapped photo, moves with the buttons and the arrow keys, and closes with Esc back on the thumbnail', async () => {
    const user = userEvent.setup();
    renderGrid();
    const second = screen.getByRole('button', { name: 'Open photo 2 of 3' });
    await user.click(second);
    expect(shown()).toHaveAccessibleName('Photo 2 of 3');
    expect(shown()).toHaveAttribute('aria-modal', 'true');
    expect(within(shown()).getByRole('img', { name: `${LABEL} 2` })).toHaveAttribute('src', `${BASE}/files/p2`);
    expect(within(shown()).getByRole('button', { name: 'Close photo' })).toHaveFocus();

    await user.click(within(shown()).getByRole('button', { name: 'Next photo' }));
    expect(shown()).toHaveAccessibleName('Photo 3 of 3');
    // The last photo has no next one.
    expect(within(shown()).getByRole('button', { name: 'Next photo' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(within(shown()).getByRole('button', { name: 'Next photo' }));
    expect(shown()).toHaveAccessibleName('Photo 3 of 3');

    await user.keyboard('{ArrowLeft}');
    expect(shown()).toHaveAccessibleName('Photo 2 of 3');
    await user.keyboard('{ArrowLeft}');
    expect(shown()).toHaveAccessibleName('Photo 1 of 3');
    await user.keyboard('{ArrowRight}');
    expect(shown()).toHaveAccessibleName('Photo 2 of 3');
    await user.click(within(shown()).getByRole('button', { name: 'Previous photo' }));
    expect(shown()).toHaveAccessibleName('Photo 1 of 3');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(second).toHaveFocus());
  });

  it('moves to the next or previous photo with a swipe, but not with a short drag', async () => {
    const user = userEvent.setup();
    renderGrid();
    await user.click(screen.getByRole('button', { name: 'Open photo 1 of 3' }));
    const stage = screen.getByTestId('lightbox-stage');
    fireEvent.pointerDown(stage, { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(stage, { clientX: 180, clientY: 210 });
    expect(shown()).toHaveAccessibleName('Photo 2 of 3');
    fireEvent.pointerDown(stage, { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(stage, { clientX: 270, clientY: 200 });
    expect(shown()).toHaveAccessibleName('Photo 2 of 3');
    // Mostly up and down is a scroll, not a swipe.
    fireEvent.pointerDown(stage, { clientX: 300, clientY: 100 });
    fireEvent.pointerUp(stage, { clientX: 240, clientY: 300 });
    expect(shown()).toHaveAccessibleName('Photo 2 of 3');
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 200 });
    fireEvent.pointerUp(stage, { clientX: 220, clientY: 200 });
    expect(shown()).toHaveAccessibleName('Photo 1 of 3');
  });

  it('closes with × and with a tap outside the photo', async () => {
    const user = userEvent.setup();
    renderGrid(['p1']);
    const thumb = screen.getByRole('button', { name: 'Open photo 1 of 1' });
    await user.click(thumb);
    // One photo: nothing to move to.
    expect(within(shown()).queryByRole('button', { name: 'Next photo' })).not.toBeInTheDocument();
    await user.click(within(shown()).getByRole('button', { name: 'Close photo' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(thumb).toHaveFocus());

    await user.click(thumb);
    await user.click(screen.getByTestId('lightbox-stage'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows nothing without photos', () => {
    renderGrid([]);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('avatar (D83)', () => {
  it("shows the photo, and the initial when there is none or it can't be loaded", () => {
    const { container, rerender } = render(
      <ApiProvider api={createApi(BASE)} config={config}>
        <Avatar name={NAME} photoId="ph1" />
      </ApiProvider>,
    );
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', `${BASE}/files/ph1`);
    fireEvent.error(img as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('D');

    rerender(
      <ApiProvider api={createApi(BASE)} config={config}>
        <Avatar name={NAME} photoId={null} />
      </ApiProvider>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('D');
  });
});
