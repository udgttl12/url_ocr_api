import crypto from "node:crypto";

const jobs = new Map();

const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function createJob() {
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    error: null,
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
  return job;
}

// Periodic cleanup of expired jobs
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - new Date(job.createdAt).getTime() > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();
