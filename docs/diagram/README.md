# Mermaid 다이어그램

이 디렉터리의 `.mmd` 세 파일이 **정본**입니다. [아키텍처 문서](../architecture.md)에는 2배 해상도 PNG, 인접한 원본·SVG 링크와 접을 수 있는 Mermaid 코드가 들어갑니다. 현재 구현을 설명하는 그림이며 미구현 제안도가 아닙니다.

| 정본 | SVG | PNG | 설명 |
| --- | --- | --- | --- |
| [modules.mmd](modules.mmd) | [SVG](modules.svg) | [PNG](modules.png) | 모듈 책임과 직접 자식 감시 범위 |
| [auth-exec.mmd](auth-exec.mmd) | [SVG](auth-exec.svg) | [PNG](auth-exec.png) | 사용자 승인·인증·시험·도구 실행 |
| [grant-lifecycle.mmd](grant-lifecycle.mmd) | [SVG](grant-lifecycle.svg) | [PNG](grant-lifecycle.png) | 허가·철회·재인증 차단 상태 |

## Podman으로 재생성

호스트에 Chromium이나 관련 라이브러리를 설치하지 않습니다. Bun과 **rootless Podman**이 있는 Unix 환경에서 `pi-sudo` 루트를 기준으로 실행합니다.

```bash
bun run docs:render
bun run docs:check
```

[`scripts/render-diagrams.ts`](../../scripts/render-diagrams.ts)는 다음 이미지 digest를 고정합니다. 기존 `11.4.3` 태그 이미지의 실제 `mmdc --version` 출력은 `11.4.2`였으므로 태그 이름과 CLI 버전을 구분합니다.

```text
ghcr.io/mermaid-js/mermaid-cli/mermaid-cli@sha256:01c60f8b1f5ff4e5633aa6a527f399baabf2443f181db28cdaa8d2967bf65e46
```

스크립트는 `--pull=never`를 사용합니다. 로컬 이미지가 없을 때만 별도로 출처와 네트워크 정책을 확인한 뒤 준비하세요. 자동 다운로드하지 않습니다.

```bash
podman pull ghcr.io/mermaid-js/mermaid-cli/mermaid-cli@sha256:01c60f8b1f5ff4e5633aa6a527f399baabf2443f181db28cdaa8d2967bf65e46
```

- 네트워크 없음, 모든 capability 제거, `no-new-privileges`, 읽기 전용 루트 파일시스템으로 실행합니다.
- 소스 디렉터리는 읽기 전용으로 마운트하고 임시 출력 디렉터리만 쓰기 가능하게 합니다. `/tmp`는 크기가 제한된 tmpfs입니다.
- `--userns=keep-id`와 호출자 UID/GID를 사용하며 `sudo`나 privileged 컨테이너를 사용하지 않습니다.
- **이미지의 기본 Chromium 설정은 `--no-sandbox`입니다.** 브라우저 sandbox가 켜져 있다고 가정하지 마세요. rootless 컨테이너 제한을 별도 격리 경계로 사용하며, 검토한 로컬 `.mmd`만 입력합니다.
- 세 도식의 SVG·PNG를 모두 성공적으로 렌더링한 뒤 결과를 복사합니다. 흰 배경, viewport 폭 1800, scale 2를 사용합니다. 실패한 렌더가 기존 이미지 일부를 덮어쓰지 않습니다.
- 렌더 후 Markdown 블록도 자동 동기화합니다. PNG에서 한글·잘림·연결선을 확인하고 SVG와 원본 링크도 점검하세요.

## Markdown만 동기화·검사

```bash
bun run docs:diagrams
bun run docs:check
```

[`scripts/sync-diagrams.ts`](../../scripts/sync-diagrams.ts)가 `architecture.md`의 `diagram:*:start/end` 사이를 생성합니다. 블록을 직접 수정하지 마세요. `docs:check`는 원본 코드와 Markdown 블록의 일치만 검사합니다. 이미지가 최신인지, 링크 대상이 존재하는지 또는 Mermaid 문법이 유효한지까지 확인하는 명령은 아닙니다. `.mmd`를 바꾸면 `docs:render`도 실행해야 합니다.

호스트에서 `bunx mmdc`를 실행했을 때는 Chromium의 `libnss3.so` 등 공유 라이브러리 부재로 실패했지만, 위 Podman 경로에서는 SVG 3개와 PNG 3개의 생성 및 한글 표시를 확인했습니다. 이는 sudo 실제 인증 테스트와 무관한 문서 렌더 검증입니다.
