// 아이콘 하나로 여는 작은 안내창. 화면을 떠나지 않고 요건을 확인하게 하는 용도다.
//
// 왜 hover 전용이 아닌가: 모바일에는 hover 가 없다. 그래서 클릭(토글)을 기본으로 하고
// 데스크톱 hover 는 CSS 로 덤으로 얹었다. 클릭으로 열면 읽는 동안 사라지지 않는다.
import { useEffect, useRef, useState } from "react";
import { APPRAISAL_RULES, NOT_FOUND_LABEL } from "./caseModel";

export function InfoTip({ label = "도움말", children }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  // 바깥 클릭·Esc 로 닫는다. 안내창이 화면에 남아 본문을 가리면 그게 더 불편하다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <span className={`itip${open ? " open" : ""}`} ref={wrap}>
      <button
        type="button" className="itip-btn" aria-label={label} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >?</button>
      <span className="itip-pop" role="tooltip">{children}</span>
    </span>
  );
}

// 감정가가 나오는 요건 — 글은 caseModel.APPRAISAL_RULES 에서 온다(판정 로직과 한 소스).
export function AppraisalTip() {
  const R = APPRAISAL_RULES;
  return (
    <InfoTip label="감정가가 나오는 요건">
      <b className="itip-h">감정가가 나오는 요건</b>
      <ol className="itip-need">
        {R.need.map((x) => <li key={x.t}><b>{x.t}</b><span>{x.d}</span></li>)}
      </ol>

      <b className="itip-h">찾는 순서</b>
      <ol className="itip-need">
        {R.sources.map((x) => <li key={x.t}><b>{x.t}</b><span>{x.d}</span></li>)}
      </ol>

      <b className="itip-h">못 가져오면 사유를 알려줍니다</b>
      <p className="itip-miss">{R.missKeys.map((k) => NOT_FOUND_LABEL[k]).join(" · ")}</p>
    </InfoTip>
  );
}
