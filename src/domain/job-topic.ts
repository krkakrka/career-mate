export const JOB_TOPICS = ['enrichment', 'notification', 'refresh', 'discovery', 'tips'] as const;
export type JobTopic = (typeof JOB_TOPICS)[number];
