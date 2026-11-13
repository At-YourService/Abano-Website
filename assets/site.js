(function () {
  var nav = document.querySelector(".mobile_nav");
  var menu = document.getElementById("mobile_menu");
  var bar = document.querySelector(".mobile_menu_bar_toggle");
  if (nav && menu && bar) {
    menu.style.display = "none";
    bar.addEventListener("click", function () {
      var open = nav.classList.toggle("opened");
      nav.classList.toggle("closed", !open);
      menu.style.display = open ? "block" : "none";
    });
  }
})();
