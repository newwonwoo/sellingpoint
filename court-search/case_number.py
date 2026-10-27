"""네트워크/브라우저 의존성 없는 사건번호 형식 검증."""
import re


def parse_case_no(case_no: str):
    m = (re.fullmatch(r'([0-9]{4})([가-힣]+)([0-9]+)', case_no.strip())
         if isinstance(case_no, str) else None)
    if not m:
        raise ValueError('사건번호 형식 오류: 앞 연도는 ASCII 숫자 4자리여야 합니다 '
                         '(예: 2026타인3944). 원 입력을 확인해 주세요.')
    return m.group(1), m.group(2), m.group(3)

