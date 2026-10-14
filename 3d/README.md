# NIGHT ECHO 3D

three.js 렌더러로 갈아끼운 3D 판입니다. 게임 로직(경비 AI, 시야, 조명, 소리, 점수)은
`../src/` 모듈을 **수정 없이** 그대로 import하고, 렌더링만 `render3d.js`가 맡습니다.

- `index.html` — 2D판 index.html 기반, three.js는 jsDelivr importmap(0.170.0)으로 로드
- `main3d.js` — `src/main.js`와 동일, 렌더러만 교체 + 마우스 조준을 3D 바닥 레이캐스트로 대체
- `render3d.js` — three.js 렌더러 (2D판 `render.js`와 같은 인터페이스)
- `style3d.css` — 야투/피격 오버레이, 3D 배지

조명·전장의 안개는 2D판과 같은 방식으로 매 프레임 작은 월드 캔버스에 그린 뒤
모든 재질이 월드 XZ로 샘플링합니다. 그래서 LIGHT 게이지와 화면의 어둠이 정확히 일치합니다.

추가 조작: `V` 시점 전환(사선/수직), 마우스 휠 줌, 천장 조명·카메라는 커서를 올리면 자동 조준.
진행 기록은 2D판과 공유됩니다(같은 localStorage 키).

저장소 루트에 그대로 `3d/` 폴더로 넣으면 `/3d/`에서 플레이됩니다.
