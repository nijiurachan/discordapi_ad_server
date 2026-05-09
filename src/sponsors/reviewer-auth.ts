export type ReviewerPayload = {
  member?: { roles?: string[] };
};

export function isReviewer(payload: ReviewerPayload, reviewerRoleId: string): boolean {
  const roles = payload.member?.roles ?? [];
  return roles.includes(reviewerRoleId);
}
