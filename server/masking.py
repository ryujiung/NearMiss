# 한글 음절 범위
HANGUL_START = 0xAC00
HANGUL_END = 0xD7A3

# 복성 목록 (2글자 성)
COMPLEX_SURNAMES = {"남궁", "황보", "제갈", "선우", "서문", "독고"}


def is_hangul(char):
    """
    한글 음절인지 확인한다.
    """
    return HANGUL_START <= ord(char) <= HANGUL_END


def mask_name(name: str | None) -> str:
    """
    이름을 가린다. 성만 남기고 나머지는 ○으로 표시한다.

    - 한글 이름: 성을 유지하고 나머지를 가린다.
    - 복성(2글자): 남궁, 황보, 제갈, 선우, 서문, 독고
    - 비한글 이름: 토큰을 공백으로 나누고, 첫 토큰의 첫 글자를 유지하고 나머지를 가린다.
    - 공백만 있거나 빈 문자열: 빈 문자열을 반환한다.
    """
    name = (name or "").strip()
    if not name:
        return ""

    if is_hangul(name[0]):
        # 한글 이름: 성과 나머지를 구분
        # 2글자 복성 확인
        if len(name) >= 2 and name[:2] in COMPLEX_SURNAMES:
            surname = name[:2]
            remainder = name[2:]
        else:
            surname = name[0]
            remainder = name[1:]

        # 나머지를 ○으로 표시
        masked_remainder = "○" * len(remainder)

        if masked_remainder:
            return f"{surname} {masked_remainder}"
        else:
            return surname
    else:
        # 비한글 이름: 공백으로 나누고 처리
        tokens = name.split()
        if not tokens:
            return ""

        masked_tokens = []
        for i, token in enumerate(tokens):
            if i == 0:
                # 첫 번째 토큰(성): 첫 글자만 남기고 나머지를 가린다
                if len(token) == 1:
                    masked_tokens.append(token)
                else:
                    masked_tokens.append(token[0] + "○" * (len(token) - 1))
            else:
                # 그 외의 토큰(이름): 전부 가린다
                masked_tokens.append("○" * len(token))

        return " ".join(masked_tokens)


def format_identity(reporter: dict, count: int) -> str:
    """
    속보 문서의 '성명' 줄을 형식화한다.

    - count > 1: "가린_이름 등 count명"
    - count == 1: "가린_이름"
    - 이름이 없으면: "외 count명"
    """
    name = reporter.get("name", "")
    masked = mask_name(name)

    if not masked:
        # 이름이 없을 때는 "외 N명"으로 표시
        return f"외 {count}명"

    if count > 1:
        return f"{masked} 등 {count}명"
    else:
        return masked
