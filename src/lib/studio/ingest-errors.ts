export type SafeIngestFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export const ACTIVE_INGEST_JOB_STATUSES = [
  "queued",
  "claimed",
  "fetching",
  "transcribing",
  "analyzing",
] as const;

export type IngestJobSummaryRow = {
  source_id: string;
  stage: string;
  progress: number;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
};

export type IngestJobPresentation = {
  stage: string;
  progress: number;
  status: string;
  needs_runner?: boolean;
  failure?: SafeIngestFailure;
};

const FAILURES: Record<string, Omit<SafeIngestFailure, "code">> = {
  video_unavailable: { message: "This video is unavailable or restricted.", retryable: false },
  metadata_failed: { message: "The video details could not be read. Update the Studio runner, then retry.", retryable: true },
  captions_unavailable: { message: "No usable captions were found, so local transcription is required.", retryable: true },
  audio_download_failed: { message: "The video's audio could not be downloaded. Update the Studio runner, then retry.", retryable: true },
  ffmpeg_missing: { message: "The Studio runner needs FFmpeg. Run the Studio runner setup again, then retry.", retryable: true },
  transcription_not_configured: { message: "Captionless video transcription is not connected. Ask your setup agent to connect OpenAI transcription, restart the Studio runner, then retry this source.", retryable: true },
  transcription_failed: { message: "The audio transcription could not finish. Retry this source.", retryable: true },
  transcription_rate_limited: { message: "The transcription service is busy. Wait a moment, then retry.", retryable: true },
  job_timeout: { message: "This source took too long to process. The runner recovered; retry this source.", retryable: true },
  runner_interrupted: { message: "The Studio runner repeatedly stopped before this source could finish. Check its local log, then retry.", retryable: true },
  runner_outdated: { message: "The Studio runner tools are out of date. Run setup again, then retry.", retryable: true },
  website_fetch_failed: { message: "The page could not be read. Check that it is public, then retry.", retryable: true },
  pdf_read_failed: { message: "The PDF could not be read. Check that it is public and contains selectable text.", retryable: true },
  unsupported_platform: { message: "This source type is not supported by the Studio runner.", retryable: false },
};

export function safeIngestFailure(raw?: string | null): SafeIngestFailure {
  const text = raw ?? "";
  const explicit = text.match(/^STUDIO:([a-z_]+):/i)?.[1]?.toLowerCase();
  if (explicit && FAILURES[explicit]) return { code: explicit, ...FAILURES[explicit] };

  if (/ffmpeg|ffprobe|postprocess/i.test(text)) return { code: "ffmpeg_missing", ...FAILURES.ffmpeg_missing };
  if (/impersonat|curl_cffi|player_client|po token|sign in to confirm|not a bot/i.test(text)) {
    return { code: "runner_outdated", ...FAILURES.runner_outdated };
  }
  if (/unavailable|private video|members-only|copyright/i.test(text)) {
    return { code: "video_unavailable", ...FAILURES.video_unavailable };
  }
  if (/429|rate.?limit|too many requests/i.test(text)) {
    return { code: "transcription_rate_limited", ...FAILURES.transcription_rate_limited };
  }
  return {
    code: "ingestion_failed",
    message: "This source could not be ingested. Retry it, or check the local Studio runner log.",
    retryable: true,
  };
}

export function presentIngestJob(job: IngestJobSummaryRow, runnerIsWorking: boolean): IngestJobPresentation {
  const queuedForMs = job.status === "queued" ? Date.now() - new Date(job.updated_at).getTime() : 0;
  const needsRunner = job.status === "queued" && queuedForMs >= 60_000 && !runnerIsWorking;
  return {
    stage: needsRunner
      ? "Waiting for Studio runner — setup needs attention"
      : job.status === "queued" && queuedForMs >= 60_000 && runnerIsWorking
        ? "Queued — runner is working through earlier sources"
        : job.stage,
    progress: job.progress,
    status: job.status,
    ...(needsRunner ? { needs_runner: true } : {}),
    ...(job.status === "failed" ? { failure: safeIngestFailure(job.error) } : {}),
  };
}
