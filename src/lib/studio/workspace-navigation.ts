const workspaceHref = (boardId: string) => `/studio/workspace#${encodeURIComponent(boardId)}`;

export const studioWorkspaceHref = (boardId: string) => workspaceHref(boardId);

// Cloudflare Static Assets cannot distinguish a Next RSC request from a full
// document request at the same pathname. Always cross this boundary with a
// browser navigation; Next router.push/router.replace are deliberately wrong.
export const openStudioWorkspace = (boardId: string) => {
  window.location.assign(workspaceHref(boardId));
};

export const replaceWithStudioWorkspace = (boardId: string) => {
  window.location.replace(workspaceHref(boardId));
};
