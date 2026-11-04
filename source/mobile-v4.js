"use strict";

(()=>{
  const mobileQuery=window.matchMedia("(max-width: 700px)");
  const standalone=window.matchMedia?.("(display-mode: standalone)")?.matches||navigator.standalone===true;
  document.body.classList.toggle("is-standalone",standalone);

  const nav=document.createElement("nav");
  nav.className="mobile-quick-nav screen-only";
  nav.setAttribute("aria-label","Navigation rapide mobile");
  const destinations=[
    ["analysis","Fichiers",".controls"],
    ["analysis","Graphique","#chart"],
    ["analysis","Pics","#peaksBody"],
    ["acquisition","Commandes",".acq-command-panel"],
    ["acquisition","Spectre","#acqSpectrum"],
    ["acquisition","Carte","#acqMapFrame"],
    ["diagnostic","Préconisations","#precoSection"],
    ["diagnostic","Campbell","#campbellSection"],
    ["diagnostic","Sifflement","#toneSection"],
    ["diagnostic","Diamètres","#diamSection"],
    ["diagnostic","Synthèse","#diagSummarySection"],
    ["diagnostic","Carte","#routeSection"]
  ];
  destinations.forEach(([mode,label,selector])=>{
    const button=document.createElement("button");
    button.type="button";button.textContent=label;button.dataset.mobileMode=mode;button.dataset.mobileTarget=selector;
    button.addEventListener("click",()=>{
      const target=document.querySelector(selector);
      if(target)target.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"});
      [...nav.querySelectorAll("button")].forEach(item=>item.classList.toggle("active",item===button));
    });
    nav.appendChild(button);
  });
  document.body.appendChild(nav);

  const backTop=document.createElement("button");
  backTop.type="button";backTop.className="mobile-back-top screen-only";backTop.textContent="↑";backTop.setAttribute("aria-label","Retour en haut");
  backTop.addEventListener("click",()=>window.scrollTo({top:0,behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"}));
  document.body.appendChild(backTop);

  function currentMode(){
    if(!document.getElementById("diagnosticMode")?.classList.contains("hidden"))return "diagnostic";
    return document.getElementById("analysisMode")?.classList.contains("hidden")?"acquisition":"analysis";}
  function updateNav(){
    const mode=currentMode();
    nav.querySelectorAll("button").forEach(button=>{button.hidden=button.dataset.mobileMode!==mode;button.classList.remove("active");});
  }
  new MutationObserver(updateNav).observe(document.getElementById("analysisMode"),{attributes:true,attributeFilter:["class"]});
  document.getElementById("modeAnalysis")?.addEventListener("click",()=>setTimeout(updateNav,0));
  document.getElementById("modeAcquisition")?.addEventListener("click",()=>setTimeout(updateNav,0));
  document.getElementById("modeDiagnostic")?.addEventListener("click",()=>setTimeout(updateNav,0));
  updateNav();

  const collapsibles=[
    ["#transmissionReference","Réglages théoriques",true],
    [".history-section","Historique et REX",true],
    ["#acquisitionMode .acq-side>section:nth-child(1)","Identification",true],
    ["#acquisitionMode .acq-side>section:nth-child(2)","Réglages audio",true],
    ["#acquisitionMode .acq-side>section:nth-child(4)","Compatibilité",true],
    ["#acquisitionMode .acq-main>section:nth-child(1)","Forme d’onde",true],
    ["#acquisitionMode .acq-main>section:nth-child(5)","Vitesse et corrélation",true],
    ["#acquisitionMode .acq-main>section:nth-child(6)","Données synchronisées",true],
    ["#acquisitionMode .acq-main>section:nth-child(7)","Marqueurs",true]
  ];
  collapsibles.forEach(([selector,label,collapsed])=>{
    const section=document.querySelector(selector);if(!section)return;
    section.classList.add("mobile-collapsible");
    section.classList.toggle("mobile-collapsed",collapsed);
    const button=document.createElement("button");
    button.type="button";button.className="mobile-section-toggle";button.textContent=label;
    button.setAttribute("aria-expanded",String(!collapsed));
    button.addEventListener("click",()=>{
      const isCollapsed=section.classList.toggle("mobile-collapsed");
      button.setAttribute("aria-expanded",String(!isCollapsed));
    });
    section.prepend(button);
  });

  let ticking=false;
  window.addEventListener("scroll",()=>{
    if(ticking)return;ticking=true;
    requestAnimationFrame(()=>{backTop.classList.toggle("visible",mobileQuery.matches&&window.scrollY>700);ticking=false;});
  },{passive:true});
})();
