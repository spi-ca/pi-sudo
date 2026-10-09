# Changelog

## v20261010-1

- 시스템 sudo AUTO 선택을 추가했습니다. `/usr/bin/sudo`를 우선하며 부재 시에만 `/usr/bin/sudo-rs`를 사용하고 PATH·alias 탐색이나 위험 경로의 대체는 하지 않습니다.
- 허가 동안 인증·시험·실행·정리에 같은 백엔드 신원을 고정하고, 경로/바이너리 변경 시 논리적 접근을 철회하여 새 명시적 unlock을 요구합니다. 자동 재인증·백엔드 재시도는 없습니다.
- 환경 변수 기반 자동 askpass는 유지하며 구형 sudo-rs의 미지원/인증 실패 시 명시적으로 실패하고 터미널·다른 백엔드로 대체하지 않습니다. 파일시스템·runner 주입 테스트를 추가했으며 실제 OS sudo 통합은 검증하지 않았습니다.

## v20261009-1

- 공개 questionnaire UI 의존성을 검증된 `pi-ask-user#v20261009-1`로 동기화했습니다. `/ui`만 사용하며 승인·sudo 정책은 바꾸지 않습니다.

- Pi 개발 의존성·lockfile·CI graph를 exact `1.1.0`으로 갱신했습니다. 관리자 권한·승인·`model-only` 경계는 유지합니다.

## v20261001-1

- Pin the host Pi development dependencies and verified runtime graph to exact `0.99.2`.
- Register `sudo_exec` as `model-only`: direct model calls retain the existing grant and failure semantics; codemode and nested tool calls cannot invoke it.
- Update tool-context regression fixtures for the host's nested-call API without changing the authorization, authentication, TUI restoration, or reauthentication policy.
- Synchronize the public questionnaire UI dependency to verified `pi-ask-user#v20261001-1`; import only `/ui`, without registering a second `ask_user` tool.

## v20261004-1

- Synchronize exact Pi host development dependencies and CI graph to `1.0.2`.
- Return completed failures with `isError: true` and status/display `details`, preserving bounded model stdout/stderr prefixes independently of the ordered UI tail. Admission/transport exceptions remain thrown; grant and revocation policy is unchanged.

- Add explicit TUI-only OS askpass unlock with root-owned canonical helper checks and auth-only environment/ignored streams. Terminal authentication remains default.
- Revoke logical grants before lock cleanup despite host failures, normalize late aborted executions, and preserve original outcomes with cleanup warnings.
- Bound final model-facing UTF-8 output including status and cleanup diagnostics. Clarify that sudo_exec, not ordinary bash, uses the grant.
- Show sudo_exec argv, cwd, progress and results in expandable tool cards; escape terminal controls without changing execution arguments.
