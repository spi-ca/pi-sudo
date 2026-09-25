# pi-sudo

Pi TUI에서 사용자가 직접 승인하고 터미널에서 인증한 뒤, 제한된 시간 동안 모델에 `sudo_exec` 호출 권한을 주는 로컬 확장입니다. **잠금 해제 중 모델은 sudo 정책이 허용하는 임의의 명령을 고를 수 있습니다.** 명령별 추가 승인이나 같은 사용자 계정(UID)의 다른 프로세스와의 보안 격리는 제공하지 않습니다.

저장소: <https://github.com/spi-ca/pi-sudo>

## 설치

확장 코드는 현재 사용자의 권한으로 실행됩니다. 설치 전 소스를 검토하세요.

```bash
pi install git:github.com/spi-ca/pi-sudo
```

설치 후 실행 중인 Pi에서 `/reload`하거나 새 세션을 시작하세요. 개발 디렉터리를 수정하는 것과 Git 설치본을 갱신하는 것은 별개입니다. Git 설치본은 `pi update git:github.com/spi-ca/pi-sudo`로 갱신한 뒤 다시 로드합니다.

## 시작하기

`package.json`의 `pi.extensions`가 루트 `index.ts`를 가리킵니다. 설치·전역 활성화 없이 검토한 로컬 경로를 명시해 대화형 터미널에서 실행합니다.

```bash
pi -e /absolute/path/to/pi-sudo/index.ts
```

Linux/macOS의 일반 사용자, 실제 터미널 입출력, 적합한 `/usr/bin/sudo`가 필요합니다. 실제 sudo 인증과 GUI askpass 수동 검증은 아직 수행하지 않았습니다.

1. `/sudo unlock`을 실행해 경고를 확인하고 **실제 터미널**에서 인증합니다. 기본 유효 기간은 5분이며 `/sudo unlock 1`부터 `/sudo unlock 15`까지 정수 분을 지정할 수 있습니다.
선택적으로 `/sudo unlock --askpass` 또는 `/sudo unlock 1 --askpass`를 사용하면 명시적으로 설정한 `SUDO_ASKPASS`의 신뢰 가능한 시스템 도우미를 sudo가 호출합니다. 기본값은 여전히 터미널 인증입니다. 어느 모드든 권한을 사용하는 도구는 일반 `bash`가 아닌 `sudo_exec`입니다.

2. 잠금 해제 중 모델은 예를 들어 `sudo_exec`에 `{"executable":"/usr/bin/id","args":["-u"]}`를 전달할 수 있습니다. `cwd`는 선택적 절대 경로입니다. 쉘 문자열이 아니라 실행 파일과 인수 배열을 전달합니다.
3. `/sudo status`로 남은 시간을 보고 `/sudo lock`으로 즉시 확장 접근을 차단합니다. `sudo -k`에 의한 OS 캐시 무효화는 실패하거나 다른 프로세스에 의해 다시 채워질 수 있습니다.

## 문서

| 주제 | 문서 |
| --- | --- |
| 명령·도구 형식과 제한 | [`docs/usage.md`](docs/usage.md) |
| 권한·캐시·실패 시 안전 경계 | [`docs/security.md`](docs/security.md) |
| 모듈 책임·인증과 접근 수명 | [`docs/architecture.md`](docs/architecture.md) |
| 로컬 검증과 수동 확인 | [`docs/development.md`](docs/development.md) |
| Mermaid 정본과 렌더링 | [`docs/diagram/README.md`](docs/diagram/README.md) |

GitHub 저장소는 공개이며 `package.json`의 `private: true`는 npm 게시를 막는 설정입니다. Git 또는 로컬 경로로 사용할 수 있으며 sudo 정책 변경은 필요하지 않습니다.
