/**
 * `quickdesign video lipsync|lipsync-status|lipsync-wait`
 *
 * Moves the mouth of the person in a video to new speech (sync-lipsync v3).
 * The job is started by the public MCP tool quickdesign_video_lipsync on
 * /api/mcp (it has no JSON REST route: POST /api/lipsync/start takes file
 * uploads from the web app) and followed on GET /api/lipsync/status/:jobId.
 *
 * Sources: the video is a design id or a QuickDesign-hosted URL, the speech an
 * audio (or video) design id or a QuickDesign-hosted audio URL. Local files
 * are uploaded first, which makes them QuickDesign-hosted.
 */
import { Command } from 'commander';
import ora from 'ora';
import { request } from '../client.js';
import { emitJson, fail, note } from '../utils/output.js';
import { pollUntilDone } from '../utils/poll.js';
import { downloadTo } from '../utils/download.js';
import { ensureRemoteUrl, looksLikeLocalPath } from '../utils/upload.js';
import { callMcpTool } from '../utils/mcp.js';

const LIPSYNC_UNAVAILABLE = 'This QuickDesign server does not support `video lipsync` yet; it needs a newer BFF.';
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const FAILED = new Set(['failed', 'timeout', 'cancelled']);

interface LipsyncStarted {
  jobId?: string;
  status?: string;
  cost?: number;
  duration_sec?: number;
  note?: string;
}

interface LipsyncStatusResponse {
  success?: boolean;
  message?: string;
  data?: {
    jobId?: string;
    status?: string;
    result_video_url?: string;
    error_message?: string;
    estimated_completion_at?: string;
  } | null;
}

const positiveInt = (v: string): number => (/^\d+$/.test(v) ? parseInt(v, 10) : NaN);

/** The extension of a path or URL, ignoring a query string. */
function isVideoFile(src: string): boolean {
  return VIDEO_EXT.test(src.split(/[?#]/)[0]);
}

async function waitForLipsync(jobId: string, opts: { interval?: number; timeout?: number; output?: string }): Promise<void> {
  const spin = ora({ text: `Waiting for lip-sync (${jobId})…`, stream: process.stderr }).start();
  let url: string;
  try {
    url = await pollUntilDone<string>(async () => {
      const s = await request<LipsyncStatusResponse>(`/api/lipsync/status/${encodeURIComponent(jobId)}`);
      const status = s.data?.status;
      if (status && FAILED.has(status)) return { done: false, error: s.data?.error_message || `Lip-sync ${status}` };
      if (status !== 'completed') {
        spin.text = `Waiting for lip-sync (${jobId})… ${status ?? '?'}`;
        return { done: false };
      }
      if (!s.data?.result_video_url) return { done: false, error: 'The finished lip-sync had no video URL' };
      return { done: true, result: s.data.result_video_url };
    }, { intervalMs: opts.interval ?? 5000, timeoutMs: opts.timeout });
  } catch (err) {
    spin.fail('Lip-sync did not finish');
    throw err;
  }
  spin.succeed('Lip-sync ready');

  if (opts.output) {
    await downloadTo(url, opts.output);
    note(`Saved ${opts.output}`);
    emitJson({ request_id: jobId, url, outputPath: opts.output });
  } else {
    emitJson({ request_id: jobId, url });
  }
}

export function registerVideoLipsyncCommands(video: Command): void {
  video
    .command('lipsync')
    .description('Sync the mouth of the person in a video to new speech (sync-lipsync v3; 10 credits per started second)')
    .option('--video <url|path>', 'The video: a local file (uploaded first) or a QuickDesign-hosted URL')
    .option('--video-design <id>', 'Or the video as a design id (yours, or one in a collection you can use)', positiveInt)
    .option('--audio <url|path>', 'The new speech: a local audio file (uploaded first) or a QuickDesign-hosted audio URL')
    .option('--audio-design <id>', 'Or the speech as an audio (or video) design id', positiveInt)
    .option('--wait', 'Block until the job completes', false)
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 1_200_000)
    .option('--interval <ms>', 'Poll interval in ms', (v) => parseInt(v, 10), 5_000)
    .option('-o, --output <path>', 'Save the result to this path (implies --wait)')
    .addHelpText('after', `
The result lasts as long as the shorter of the video and the speech (at most
120 s) and is saved as a video design. It works best on one clearly visible face.
URLs from elsewhere are refused by the server: download the file and pass its path.

Examples:
  $ quickdesign video lipsync --video ./take.mp4 --audio ./new-line.mp3 -o ./synced.mp4
  $ quickdesign video lipsync --video-design 88876 --audio-design 88901 --wait
`)
    .action(async (opts: {
      video?: string;
      videoDesign?: number;
      audio?: string;
      audioDesign?: number;
      wait?: boolean;
      timeout?: number;
      interval?: number;
      output?: string;
    }) => {
      try {
        if ((opts.video !== undefined) === (opts.videoDesign !== undefined)) {
          fail('Pass exactly one of --video or --video-design', 2);
        }
        if ((opts.audio !== undefined) === (opts.audioDesign !== undefined)) {
          fail('Pass exactly one of --audio or --audio-design', 2);
        }
        for (const [flag, id] of [['--video-design', opts.videoDesign], ['--audio-design', opts.audioDesign]] as const) {
          if (id !== undefined && !(Number.isInteger(id) && id > 0)) fail(`${flag} must be a positive design id`, 2);
        }
        if (opts.audio !== undefined && isVideoFile(opts.audio)) {
          fail('--audio takes an audio file (mp3, wav, m4a, ogg). To use a video\'s sound, pass that video\'s design id as --audio-design.', 2);
        }

        const toUrl = (src: string) => (looksLikeLocalPath(src) ? ensureRemoteUrl(src) : Promise.resolve(src));
        const [videoUrl, audioUrl] = await Promise.all([
          opts.video !== undefined ? toUrl(opts.video) : Promise.resolve(undefined),
          opts.audio !== undefined ? toUrl(opts.audio) : Promise.resolve(undefined),
        ]);

        const args: Record<string, unknown> = {
          ...(videoUrl !== undefined ? { video_url: videoUrl } : { design_id: opts.videoDesign }),
          ...(audioUrl !== undefined ? { audio_url: audioUrl } : { audio_design_id: opts.audioDesign }),
        };
        // The tool probes both files (and may extract a video design's sound) before it answers.
        const result = await callMcpTool('quickdesign_video_lipsync', args, {
          timeoutMs: 180_000,
          unavailableMessage: LIPSYNC_UNAVAILABLE,
        });
        const textPart = result.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
        if (result.isError) fail(textPart?.text ?? 'Lip-sync failed');
        let started: LipsyncStarted;
        try {
          started = JSON.parse(textPart?.text ?? '') as LipsyncStarted;
        } catch {
          fail(`Unexpected reply from the server: ${(textPart?.text ?? '').slice(0, 300)}`);
        }
        const jobId = started!.jobId;
        if (!jobId) fail(`No jobId in the reply: ${JSON.stringify(started!)}`);
        if (started!.note) note(started!.note);

        if (!(opts.wait === true || Boolean(opts.output))) {
          emitJson({
            request_id: jobId,
            status: started!.status ?? 'processing',
            token_cost: started!.cost,
            duration_sec: started!.duration_sec,
            ...(started!.note ? { note: started!.note } : {}),
          });
          return;
        }
        await waitForLipsync(jobId!, opts);
      } catch (err) { fail(err); }
    });

  video
    .command('lipsync-status')
    .description('Check a lip-sync job')
    .argument('<jobId>', 'Job id returned by `lipsync`')
    .action(async (jobId: string) => {
      try {
        emitJson(await request<LipsyncStatusResponse>(`/api/lipsync/status/${encodeURIComponent(jobId)}`));
      } catch (err) { fail(err); }
    });

  video
    .command('lipsync-wait')
    .description('Resume waiting on a previously-started lip-sync job and (optionally) save the result')
    .argument('<jobId>', 'Job id returned by `lipsync`')
    .option('--timeout <ms>', 'Wait timeout in ms', (v) => parseInt(v, 10), 1_200_000)
    .option('--interval <ms>', 'Poll interval in ms', (v) => parseInt(v, 10), 5_000)
    .option('-o, --output <path>', 'Save the result to this path')
    .action(async (jobId: string, opts: { timeout?: number; interval?: number; output?: string }) => {
      try {
        await waitForLipsync(jobId, opts);
      } catch (err) { fail(err); }
    });
}
