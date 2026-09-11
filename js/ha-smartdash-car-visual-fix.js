(function () {
  const MODEL_Y_IMAGE_URL = "https://static-assets.tesla.com/v1/compositor/?model=my&view=STUD_3QTR&size=1440&bkba_opt=1&options=$PBSB,$WY19B,$MTY09,$INPB0&crop=1450,500,250,300";

  function injectStyles() {
    if (document.getElementById("beastCarVisualFixStyles")) return;
    const style = document.createElement("style");
    style.id = "beastCarVisualFixStyles";
    style.textContent = `
      .beast-car-v3-visual{height:390px!important;width:min(100%,620px)!important;margin-top:2px!important}
      .beast-car-v3-model-y-host{top:18px!important;width:520px!important;height:330px!important;background:transparent!important;overflow:visible!important}
      .beast-car-v3-model-y-image{width:100%!important;height:100%!important;object-fit:contain!important;background:transparent!important;transform:scale(1.12);transform-origin:center center;filter:drop-shadow(0 18px 18px rgba(0,0,0,.24))!important}

      .beast-car-v3-tire{
        min-width:82px!important;
        min-height:52px!important;
        padding:7px 10px 8px!important;
        border:1px solid var(--border-strong)!important;
        border-radius:14px!important;
        background:var(--surface-2)!important;
        box-shadow:var(--shadow-card)!important;
        backdrop-filter:blur(12px)!important;
        -webkit-backdrop-filter:blur(12px)!important;
        grid-template-columns:auto auto!important;
        column-gap:5px!important;
      }
      .beast-car-v3-tire small{
        color:var(--ink-muted)!important;
        font-size:.63rem!important;
        font-weight:800!important;
        letter-spacing:.06em!important;
      }
      .beast-car-v3-tire strong{
        color:var(--ink)!important;
        font-size:1.32rem!important;
        line-height:1.05!important;
        font-weight:850!important;
      }
      .beast-car-v3-tire span{
        color:var(--ink-muted)!important;
        font-size:.64rem!important;
        font-weight:700!important;
      }
      .beast-car-v3-tire.is-low{
        border-color:color-mix(in srgb,var(--warning) 42%,transparent)!important;
        background:var(--warning-soft)!important;
      }
      .beast-car-v3-tire.is-low strong{color:var(--warning)!important}

      /* Placement follows the car's perspective in the Tesla 3/4 render:
         front-left = lower-left, front-right = upper-left,
         rear-left = lower-right, rear-right = upper-right. */
      .beast-car-v3-tire-fl{left:18px!important;right:auto!important;top:auto!important;bottom:54px!important}
      .beast-car-v3-tire-fr{left:18px!important;right:auto!important;top:76px!important;bottom:auto!important}
      .beast-car-v3-tire-rl{left:auto!important;right:18px!important;top:auto!important;bottom:54px!important}
      .beast-car-v3-tire-rr{left:auto!important;right:18px!important;top:76px!important;bottom:auto!important}

      @media(max-width:700px){
        .beast-car-v3-visual{height:370px!important}
        .beast-car-v3-model-y-host{top:14px!important;width:480px!important;height:310px!important}
        .beast-car-v3-model-y-image{transform:scale(1.08)}
        .beast-car-v3-tire-fl{left:12px!important;bottom:50px!important}
        .beast-car-v3-tire-fr{left:12px!important;top:70px!important}
        .beast-car-v3-tire-rl{right:12px!important;bottom:50px!important}
        .beast-car-v3-tire-rr{right:12px!important;top:70px!important}
      }
    `;
    document.head.appendChild(style);
  }

  function applyImage() {
    const image = document.querySelector(".beast-car-v3-model-y-image");
    if (!image) return false;
    if (image.getAttribute("src") !== MODEL_Y_IMAGE_URL) image.setAttribute("src", MODEL_Y_IMAGE_URL);
    image.setAttribute("alt", "Sort Tesla Model Y 2021");
    return true;
  }

  function apply() {
    injectStyles();
    applyImage();
  }

  const observer = new MutationObserver(() => apply());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
})();
