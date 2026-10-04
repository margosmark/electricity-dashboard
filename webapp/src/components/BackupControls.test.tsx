/**
 * Wave G item 1 — the Backup drawer (one pair of buttons: Export JSON /
 * Import JSON) that makes the browser-profile-only storage recoverable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackupControls, type BackupFileResult } from './BackupControls';
import { BACKUP_SCHEMA } from '@/lib/backup';

const downloadMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/download', () => ({ downloadTextFile: downloadMock }));

const SAMPLE_DOC = {
  schema: BACKUP_SCHEMA,
  version: 1,
  exportedAt: '2026-10-02T12:00:00.000Z',
  payload: { energy_data: [{ timestamp: 1704067200, usage_kwh: 1.5 }], billing_day: 7, extra_charges: {} },
};

beforeEach(() => {
  downloadMock.mockClear();
});

describe('BackupControls', () => {
  it('keeps the pair of buttons behind a drawer until asked', () => {
    render(<BackupControls onExport={() => null} onImport={async () => ({ ok: true })} />);
    expect(screen.queryByTestId('backup-export')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backup-import')).not.toBeInTheDocument();
    expect(screen.getByTestId('backup-toggle')).toBeInTheDocument();
  });

  it('opens the drawer and explains what a backup is for', async () => {
    const user = userEvent.setup();
    render(<BackupControls onExport={() => null} onImport={async () => ({ ok: true })} />);
    await user.click(screen.getByTestId('backup-toggle'));
    expect(screen.getByTestId('backup-export')).toBeInTheDocument();
    expect(screen.getByTestId('backup-import')).toBeInTheDocument();
    expect(screen.getByTestId('backup-drawer')).toHaveTextContent(/everything lives in this browser/i);
  });

  it('exports a versioned JSON file through the download helper', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn(() => ({ filename: 'energy-backup_2026-10-02.json', text: JSON.stringify(SAMPLE_DOC) }));
    render(<BackupControls onExport={onExport} onImport={async () => ({ ok: true })} />);
    await user.click(screen.getByTestId('backup-toggle'));
    await user.click(screen.getByTestId('backup-export'));

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(downloadMock).toHaveBeenCalledTimes(1);
    const [filename, text] = downloadMock.mock.calls[0];
    expect(filename).toBe('energy-backup_2026-10-02.json');
    expect(JSON.parse(text as string).schema).toBe(BACKUP_SCHEMA);
    await waitFor(() => expect(screen.getByTestId('backup-status')).toHaveTextContent(/energy-backup_2026-10-02\.json/));
  });

  it('shows nothing when there is no data to export', async () => {
    const user = userEvent.setup();
    render(<BackupControls onExport={() => null} onImport={async () => ({ ok: true })} />);
    await user.click(screen.getByTestId('backup-toggle'));
    await user.click(screen.getByTestId('backup-export'));
    expect(downloadMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('backup-status')).toHaveTextContent(/nothing to export/i);
  });

  it('surfaces an import failure verbatim instead of failing silently', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn(async (): Promise<BackupFileResult> => ({
      ok: false,
      error: 'That backup has an invalid billing_day (got 32, expected an integer 1–31).',
    }));
    render(<BackupControls onExport={() => null} onImport={onImport} />);
    await user.click(screen.getByTestId('backup-toggle'));

    const input = screen.getByTestId('backup-import-input') as HTMLInputElement;
    const file = new File(['{"schema":"x"}'], 'backup.json', { type: 'application/json' });
    await user.upload(input, file);

    expect(onImport).toHaveBeenCalledTimes(1);
    expect((onImport.mock.calls[0] as unknown[])[0]).toBeInstanceOf(File);
    await waitFor(() =>
      expect(screen.getByTestId('backup-error')).toHaveTextContent(/invalid billing_day/),
    );
  });

  it('reports a successful import and clears the previous error', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn(async (): Promise<BackupFileResult> => ({ ok: true, filename: 'backup.json' }));
    render(<BackupControls onExport={() => null} onImport={onImport} />);
    await user.click(screen.getByTestId('backup-toggle'));

    const input = screen.getByTestId('backup-import-input') as HTMLInputElement;
    await user.upload(input, new File(['{}'], 'backup.json', { type: 'application/json' }));

    await waitFor(() => expect(screen.getByTestId('backup-status')).toHaveTextContent(/backup\.json imported/i));
    expect(screen.queryByTestId('backup-error')).not.toBeInTheDocument();
  });
});
