/**
 * Shared response shapes + extractors for the async video BFF families
 * (generate, subtitle, upscale). Video endpoints don't expose a separate
 * `/result/:id` route — the result URLs are embedded in the status response,
 * so every poll loop reads `status === 'completed'` and pulls the URL from
 * there via `extractResultUrl`.
 */

export interface BffStartResponse {
  success?: boolean;
  data?: {
    jobId?: string;
    request_id?: string;
    status?: string;
    estimated_completion_at?: string;
    estimated_duration_minutes?: number;
    token_cost?: number;
  };
  request_id?: string;
  jobId?: string;
  requestId?: string;
  error?: string;
}

export interface BffStatusResponse {
  success?: boolean;
  data?: {
    status: 'queued' | 'processing' | 'completed' | 'failed' | string;
    progress?: number;
    /** Legacy / image-generation surface uses `error`. */
    error?: string;
    /** Seedance / UGC / video status endpoints surface the failure under
     *  `error_message`. Read both — caller picks whichever is set. */
    error_message?: string;
    video_url?: string;
    videoUrl?: string;
    output_url?: string;
    /** Seedance/UGC status endpoints return the final URL under this key. */
    result_video_url?: string;
    result?: {
      video_url?: string;
      videoUrl?: string;
      output_url?: string;
      result_video_url?: string;
    };
    merge_video_url?: string;
    segment_videos?: string[];
    pipeline_stage?: string;
  };
}

/** Pull the most informative failure string from a status response. */
export function extractFailureMessage(s: BffStatusResponse): string {
  return s.data?.error_message
    || s.data?.error
    || 'Generation failed';
}

export function extractRequestId(r: BffStartResponse): string | undefined {
  return r.data?.jobId ?? r.data?.request_id ?? r.jobId ?? r.request_id ?? r.requestId;
}

export function extractResultUrl(s: BffStatusResponse): string | undefined {
  const d = s.data;
  if (!d) return undefined;
  return (
    d.result_video_url
    ?? d.video_url
    ?? d.videoUrl
    ?? d.output_url
    ?? d.result?.result_video_url
    ?? d.result?.video_url
    ?? d.result?.videoUrl
    ?? d.result?.output_url
    ?? d.merge_video_url
    ?? d.segment_videos?.[d.segment_videos.length - 1]
  );
}
