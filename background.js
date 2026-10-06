// 툴바 아이콘을 누르면 도구 화면(index.html)을 새 탭으로 연다
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }));
