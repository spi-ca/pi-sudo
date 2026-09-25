# 개발과 검증

## 로컬 확인

`package.json`은 `private: true`, `pi.extensions: ["./index.ts"]`, Bun 테스트, TypeScript `noEmit` 검사와 문서 다이어그램 동기화 명령을 정의합니다. Pi 개발 의존성 `@earendil-works/pi-coding-agent`와 `@earendil-works/pi-ai`는 모두 정확히 `0.87.1`입니다. 기존 lockfile을 유지하며 의존성을 준비할 때:

```bash
bun install --frozen-lockfile
bun run check
bun test
bun run docs:check
```

별도 `lint`나 `ci` 스크립트는 현재 없습니다. `bun run check`는 `tsc --noEmit`, `bun test`는 `test/*.test.ts`의 모의 sudo·비특권 subprocess 테스트를 실행합니다. 결과는 터미널에 출력되며 이 패키지는 별도 report 파일을 생성하지 않습니다. `test/extension.test.ts`는 Pi 명령/도구 등록과 확인 UI·복원·shutdown을, `test/sudo.test.ts`는 clock/runner 주입으로 기한·동시성·실패·poison을, `test/process.test.ts`는 제한된 출력과 자식 종료/파이프 경계를 확인합니다. `test/docs.test.ts`는 임시 디렉터리에서 다이어그램 불일치 탐지·동기화·반복 실행·마커 오류 처리를 확인하며 실제 문서를 수정하지 않습니다. 가짜 파일 검사·runner로 askpass 경로·권한·경합·결과 제한도 검증합니다. 실제 비밀번호 입력, GUI askpass, sudo 정책, Linux/macOS 양쪽 실제 인증을 자동으로 검증하지 않습니다.

## GitHub Actions CI

[CI 워크플로](../.github/workflows/ci.yml)는 PR, `main` push, `v*` 태그 push 및 수동 실행을 지원합니다. Ubuntu에서 Bun `1.4.2`와 frozen lockfile을 사용해 타입 검사·전체 테스트·다이어그램 Markdown 동기화를 확인하고, 추적 파일 변경이 없는지 검사합니다. Actions는 커밋 SHA로 고정하며 토큰은 `contents: read`, 체크아웃 인증 정보는 유지하지 않습니다. 의존성 설치 스크립트도 실행하지 않습니다.

실제 sudo 인증·GUI askpass·macOS 인증 및 Podman 이미지 재렌더링은 CI 범위가 아닙니다. 다이어그램 검사는 `.mmd`와 Markdown의 일치만 확인합니다. CI 성공을 실제 관리자 인증이나 이미지 최신성 검증으로 해석하지 마세요.

## 수동 승인 점검

자신이 관리하는 폐기 가능한 실제 TTY와 허용된 sudo 정책에서만 수행하세요. 실행 전 [보안 경계](security.md)를 읽으세요. `/usr/bin/true`가 정책상 허용되어야 잠금 해제 시험이 성공합니다.

1. `pi -e /absolute/path/to/pi-sudo/index.ts`에서 `/sudo status`를 확인하고 `/sudo unlock 1`을 실행합니다. 확인을 거절하면 잠김을 확인하고, 다시 시도해 실제 터미널에만 인증 입력이 표시되는지 확인합니다.
2. 신뢰 가능한 root 소유 도우미가 이미 있는 경우에만 `SUDO_ASKPASS=/absolute/system/helper` 환경에서 `/sudo unlock 1`의 GUI 승인/실패를 별도로 시험합니다. 일반 사용자 소유 스크립트로 우회하지 마세요. GUI 시험은 이 저장소의 자동 테스트에 포함되지 않습니다.
3. `sudo_exec`에 `{"executable":"/usr/bin/id","args":[]}`를 요청해 정상 실행 후 `/sudo lock` 및 후속 도구 거부를 확인합니다.
4. 만료(1분), 실패한 명령, 세션 종료/재시작, 비-TTY 모드를 각각 점검합니다. 필요하면 OS sudo 캐시를 별도로 검사합니다. 후손 종료나 캐시 무효화가 항상 성공한다고 추론하지 마세요.

위 항목은 **수동 절차**이며 실제 수행 결과를 뜻하지 않습니다.

## 파일 구조와 읽는 순서

```text
index.ts                    Pi 명령·도구·사용자 확인과 TUI 어댑터
src/sudo.ts                 접근 허가와 철회, 기한·동시성 정책
src/process.ts              직접 자식 생성·출력·종료 감시
src/askpass.ts              시스템 도우미 정규화·신뢰 검사
src/output.ts               최종 모델 텍스트 크기·줄 제한
test/                       런타임 세 모듈과 문서 동기화 테스트
scripts/sync-diagrams.ts     Mermaid 정본 → Markdown 블록 동기화
scripts/render-diagrams.ts   rootless Podman으로 SVG·2x PNG 생성
README.md                   사용자 진입점
AGENTS.md                   코드 작업자를 위한 짧은 규칙
docs/                       사용·보안·설계·검증 문서
docs/diagram/*.mmd           다이어그램 정본
```

먼저 [사용 방법](usage.md)과 [보안 경계](security.md)를 읽고, [아키텍처](architecture.md)의 책임표를 따라 관심 있는 모듈과 대응 테스트를 확인하세요. 소스 주석은 코드의 줄별 번역보다 **순서가 필요한 이유와 실패 시 유지할 조건**을 설명합니다. `index.ts`의 확인 epoch와 `SudoAccess`의 인증 generation, 논리적 철회와 OS 캐시 정리, 직접 자식 exit와 파이프 close의 구분이 핵심입니다. 현재 세 모듈은 이 책임을 이미 분리하므로 문서화만을 위해 더 나누지 않습니다.

## 수정 시 주의점

`index.ts`는 UI/epoch/touched를 관리하고 실제 접근은 `src/sudo.ts`에서만 판정해야 합니다. `src/sudo.ts`는 인증 전 `-k`, 대화형 `-v`, 비대화형 `/usr/bin/true` 시험을 별도로 유지하고 실패 시 논리적 접근을 먼저 철회합니다. `src/process.ts`는 같은 부모의 non-detached 프로세스를 실행하며 직접 자식 종료와 출력 파이프 닫힘을 혼동하지 않아야 합니다. 상세 모듈 경계와 그림은 [구조](architecture.md)에 있습니다.

그림 변경 뒤 `bun run docs:render`로 rootless Podman에서 SVG·2배 해상도 PNG와 아키텍처 문서의 생성 블록을 갱신합니다. `bun run docs:diagrams`는 Markdown만 동기화하고, `bun run docs:check`는 정본 코드와 생성 블록의 일치만 확인합니다. 이미지 최신 여부·문법·렌더 검사를 대신하지 않습니다. 고정 이미지와 컨테이너 격리 조건은 [다이어그램 안내](diagram/README.md)를 따릅니다.

문서 그림의 정본은 [`docs/diagram/README.md`](diagram/README.md)에 나열된 `.mmd` 파일입니다. 구현 변경 시 다이어그램·사용 방법·보안 경계를 함께 검토하세요. README와 `docs/*.md`는 한국어, 에이전트용 `AGENTS.md`는 영어로 유지합니다.
