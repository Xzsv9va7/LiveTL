export const HC_LIVE_CHAT_BODY_EVENT = 'hcCapturedLiveChatBody';
export const HC_CONTEXT_MENU_RESPONSE_EVENT = 'hcContextMenuResponse';
export const HC_CHAT_VIEW_CHANGE_EVENT = 'hcChatViewChange';

declare function cloneInto<T>(obj: T, target: object): T;

export const isLiveChatPollUrl = (url: string): boolean =>
  url.includes('/youtubei/v1/live_chat/get_live_chat');

const publishPageEvent = (eventName: string, detail: string, pageProp?: string): void => {
  const page = (window as any).wrappedJSObject as any;
  if (pageProp != null) {
    (window as any)[pageProp] = detail;
  }
  if (page != null && typeof cloneInto === 'function') {
    if (pageProp != null) {
      try {
        page[pageProp] = cloneInto(detail, page);
      } catch {
        page[pageProp] = detail;
      }
    }
    try {
      page.dispatchEvent(new page.CustomEvent(eventName, cloneInto({ detail }, page)));
      return;
    } catch {}
  }
  window.dispatchEvent(new CustomEvent(eventName, { detail }));
};

export const publishChatViewChange = (index: number): void => {
  publishPageEvent(HC_CHAT_VIEW_CHANGE_EVENT, String(index));
};

export const publishCapturedLiveChatBody = (body: string): void => {
  if (typeof body !== 'string' || body === '' || body[0] !== '{') return;
  publishPageEvent(HC_LIVE_CHAT_BODY_EVENT, body, '__hcLastLiveChatBodyJson');
};

export const publishCapturedContextMenuResponse = (detail: string): void => {
  if (typeof detail !== 'string' || detail === '') return;
  publishPageEvent(HC_CONTEXT_MENU_RESPONSE_EVENT, detail, '__hcLastContextMenuJson');
};

export const fetchCapturedLiveChatBody = async (): Promise<string | null> => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'hcGetLastLiveChatBody' });
    return typeof response?.body === 'string' && response.body !== '' ? response.body : null;
  } catch {
    return null;
  }
};
