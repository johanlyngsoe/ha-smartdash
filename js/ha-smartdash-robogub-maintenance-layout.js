(function () {
  function addStyles() {
    if (document.getElementById("beastRobogubMaintenanceLayoutStyles")) return;
    const style = document.createElement("style");
    style.id = "beastRobogubMaintenanceLayoutStyles";
    style.textContent = `
      /* Keep sync actions readable on the portrait wall kiosk. The three
         labels are too wide for equal thirds inside the maintenance card. */
      .beast-robogub-maint-sync{
        grid-template-columns:repeat(3,minmax(0,1fr));
        align-items:stretch;
      }
      .beast-robogub-maint-sync .beast-robogub-maint-action{
        min-width:0;
        padding:8px 5px;
      }
      .beast-robogub-maint-sync .beast-robogub-maint-action>span,
      .beast-robogub-maint-sync .beast-robogub-maint-action strong{
        min-width:0;
        width:100%;
        white-space:normal;
        overflow-wrap:anywhere;
        line-height:1.12;
      }

      /* The wall kiosk is portrait but substantially wider than a phone.
         Two columns give each service action a proper touch target without
         making the maintenance section unnecessarily tall. */
      @media (orientation:portrait) and (max-width:1100px){
        .beast-robogub-maint-sync{
          grid-template-columns:repeat(2,minmax(0,1fr));
        }
        .beast-robogub-maint-sync .beast-robogub-maint-action:last-child{
          grid-column:1 / -1;
        }
        .beast-robogub-maint-sync .beast-robogub-maint-action{
          min-height:50px;
          justify-content:center;
          text-align:center;
          padding:8px 10px;
        }
      }

      @media (max-width:620px){
        .beast-robogub-maint-sync{
          grid-template-columns:1fr;
        }
        .beast-robogub-maint-sync .beast-robogub-maint-action:last-child{
          grid-column:auto;
        }
      }
    `;
    document.head.appendChild(style);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addStyles, { once: true });
  else addStyles();
})();
