import { publishCapturedContextMenuResponse, publishCapturedLiveChatBody } from '../ts/live-chat-body';

const getScriptURL = (path: string): string => {
  if (__LIVETL__) {
    return chrome.runtime.getURL('hyperchat/scripts/' + path);
  }
  return chrome.runtime.getURL('scripts/' + path);
};

const injectInterceptor = (): void => {
  if (document.documentElement.querySelector('script[data-hc-interceptor]')) return;
  const script = document.createElement('script');
  script.src = getScriptURL('chat-interceptor.js');
  script.dataset.hcInterceptor = '1';
  script.async = false;
  document.documentElement.appendChild(script);
};

chrome.runtime.onMessage.addListener((message: { type?: string; body?: string; detail?: string }) => {
  if (message?.type === 'hcLiveChatBody' && typeof message.body === 'string') {
    publishCapturedLiveChatBody(message.body);
    window.dispatchEvent(new CustomEvent('hcCapturedLiveChatBody', { detail: message.body }));
  }
  if (message?.type === 'hcMessageReceive' && typeof message.detail === 'string') {
    window.dispatchEvent(new CustomEvent('messageReceive', { detail: message.detail }));
  }
  if (message?.type === 'hcContextMenuResponse' && typeof message.detail === 'string') {
    publishCapturedContextMenuResponse(message.detail);
  }
});

if (!navigator.userAgent.includes('Firefox')) injectInterceptor();
