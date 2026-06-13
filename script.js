/* =========================
   EGYA DURIAN PREMIUM
========================= */

let cart = [];

let discount = 0;

/* =========================
   LOADER
========================= */

window.addEventListener("load", () => {

const loader =
document.getElementById("loader");

setTimeout(() => {

loader.classList.add("loader-hide");

setTimeout(() => {

loader.style.display = "none";

}, 600);

}, 1000);

});

/* =========================
   DARK MODE
========================= */

const darkBtn =
document.getElementById("darkModeBtn");

darkBtn.addEventListener("click", () => {

document.body.classList.toggle("dark");

localStorage.setItem(
"darkMode",
document.body.classList.contains("dark")
);

});

if (
localStorage.getItem("darkMode")
=== "true"
){

document.body.classList.add("dark");

}

/* =========================
   MEMBER STORAGE
========================= */

const saveMemberBtn =
document.getElementById("saveMember");

if(saveMemberBtn){

saveMemberBtn.addEventListener(
"click",
() => {

const name =
document.getElementById("memberName").value;

if(name.trim() !== ""){

localStorage.setItem(
"memberName",
name
);

showToast(
`Selamat datang ${name}`
);

}

});

}

/* =========================
   PROMO SLIDER
========================= */

const slides =
document.querySelectorAll(".slide");

let currentSlide = 0;

function promoSlider(){

slides.forEach(slide => {

slide.classList.remove("active");

});

currentSlide++;

if(
currentSlide >= slides.length
){

currentSlide = 0;

}

slides[currentSlide]
.classList.add("active");

}

setInterval(
promoSlider,
3000
);

/* =========================
   FAQ
========================= */

document
.querySelectorAll(".faq-question")
.forEach(btn => {

btn.addEventListener(
"click",
() => {

btn.parentElement
.classList.toggle("active");

});

});

/* =========================
   SEARCH
========================= */

const searchInput =
document.getElementById("searchInput");

if(searchInput){

searchInput.addEventListener(
"keyup",
() => {

let keyword =
searchInput.value.toLowerCase();

document
.querySelectorAll(".product-card")
.forEach(card => {

const title =
card.querySelector("h3")
.textContent
.toLowerCase();

if(
title.includes(keyword)
){

card.style.display = "block";

}else{

card.style.display = "none";

}

});

});

}

/* =========================
   FILTER PRODUK
========================= */

const filterBtns =
document.querySelectorAll(".filter-btn");

filterBtns.forEach(btn => {

btn.addEventListener(
"click",
() => {

filterBtns.forEach(b => {

b.classList.remove("active");

});

btn.classList.add("active");

const category =
btn.dataset.category;

document
.querySelectorAll(".product-card")
.forEach(card => {

if(
category === "all"
){

card.style.display = "block";

return;

}

if(
card.dataset.category
=== category
){

card.style.display = "block";

}else{

card.style.display = "none";

}

});

});

});

/* =========================
   QTY BUTTON
========================= */

document
.querySelectorAll(".plus-btn")
.forEach(btn => {

btn.addEventListener(
"click",
() => {

let input =
btn.parentElement
.querySelector(".qty-input");

input.value =
parseInt(input.value) + 1;

});

});

document
.querySelectorAll(".minus-btn")
.forEach(btn => {

btn.addEventListener(
"click",
() => {

let input =
btn.parentElement
.querySelector(".qty-input");

if(
parseInt(input.value) > 0
){

input.value =
parseInt(input.value) - 1;

}

});

});

/* =========================
   TOAST
========================= */

function showToast(text){

const toast =
document.getElementById("toast");

toast.innerText = text;

toast.classList.add("show");

setTimeout(() => {

toast.classList.remove("show");

}, 2500);

}
/* =========================
   WISHLIST
========================= */

let wishlist = JSON.parse(
localStorage.getItem("wishlist")
) || [];

document
.querySelectorAll(".wishlist-btn")
.forEach((btn,index)=>{

if(wishlist.includes(index)){
btn.classList.add("active");
}

btn.addEventListener("click",()=>{

btn.classList.toggle("active");

if(btn.classList.contains("active")){

wishlist.push(index);

showToast(
"❤️ Ditambahkan ke Wishlist"
);

}else{

wishlist = wishlist.filter(
item => item !== index
);

showToast(
"💔 Dihapus dari Wishlist"
);

}

localStorage.setItem(
"wishlist",
JSON.stringify(wishlist)
);

});

});

/* =========================
   CART ELEMENT
========================= */

const cartBtn =
document.getElementById("cartBtn");

const cartSidebar =
document.getElementById("cartSidebar");

const closeCart =
document.getElementById("closeCart");

const overlay =
document.getElementById("overlay");

const cartItems =
document.getElementById("cart-items");

const cartCount =
document.getElementById("cart-count");

const cartTotal =
document.getElementById("cart-total");

/* =========================
   OPEN CLOSE CART
========================= */

cartBtn.addEventListener(
"click",
()=>{

cartSidebar.classList.add("active");
overlay.classList.add("active");

});

closeCart.addEventListener(
"click",
closeSidebar
);

overlay.addEventListener(
"click",
closeSidebar
);

function closeSidebar(){

cartSidebar.classList.remove("active");
overlay.classList.remove("active");

}

/* =========================
   ADD TO CART
========================= */

document
.querySelectorAll(".buy-btn")
.forEach(btn=>{

btn.addEventListener(
"click",
()=>{

const card =
btn.closest(".product-card");

const name =
card.querySelector("h3")
.innerText;

const price =
parseInt(
card.dataset.price
);

const qty =
parseInt(
card.querySelector(".qty-input")
.value
);

if(qty <= 0){

showToast(
"Masukkan jumlah terlebih dahulu"
);

return;

}

let existing =
cart.find(
item => item.name === name
);

if(existing){

existing.qty += qty;

}else{

cart.push({

name:name,
price:price,
qty:qty

});

}

showToast(
"🛒 Produk ditambahkan"
);

updateCart();

saveCart();

});

});

/* =========================
   UPDATE CART
========================= */

function updateCart(){

cartItems.innerHTML = "";

let total = 0;
let totalQty = 0;

if(cart.length === 0){

cartItems.innerHTML =

"<p>Belum ada produk</p>";

cartCount.innerText = "0";
cartTotal.innerText = "0";

return;

}

cart.forEach((item,index)=>{

total +=
item.price * item.qty;

totalQty += item.qty;

cartItems.innerHTML +=

`
<div class="cart-item">

<div>

<strong>
${item.name}
</strong>

<p>
Rp ${item.price.toLocaleString()}
</p>

<div class="cart-qty">

<button
class="cart-minus"
onclick="changeQty(${index},-1)">

-

</button>

<span>

${item.qty}

</span>

<button
class="cart-plus"
onclick="changeQty(${index},1)">

+

</button>

</div>

</div>

<div>

<button
class="remove-btn"
onclick="removeItem(${index})">

Hapus

</button>

</div>

</div>
`;

});

if(discount > 0){

total =
total -
(total * discount / 100);

}

cartCount.innerText =
totalQty;

cartTotal.innerText =
total.toLocaleString();

}

/* =========================
   CHANGE QTY
========================= */

function changeQty(index,value){

cart[index].qty += value;

if(
cart[index].qty <= 0
){

cart.splice(index,1);

}

updateCart();
saveCart();

}

/* =========================
   REMOVE ITEM
========================= */

function removeItem(index){

cart.splice(index,1);

updateCart();
saveCart();

showToast(
"🗑️ Produk dihapus"
);

}

/* =========================
   SAVE CART
========================= */

function saveCart(){

localStorage.setItem(
"durianCart",
JSON.stringify(cart)
);

}

/* =========================
   LOAD CART
========================= */

function loadCart(){

const savedCart =
localStorage.getItem(
"durianCart"
);

if(savedCart){

cart =
JSON.parse(savedCart);

updateCart();

}

}

loadCart();

/* =========================
   VOUCHER
========================= */

const voucherBtn =
document.getElementById(
"applyVoucher"
);

voucherBtn.addEventListener(
"click",
()=>{

const code =
document
.getElementById(
"voucherInput"
)
.value
.toUpperCase();

if(code === "EGYA10"){

discount = 10;

document
.getElementById(
"discountInfo"
)
.innerText =
"Voucher 10% Aktif";

showToast(
"🎉 Voucher berhasil digunakan"
);

}
else if(
code === "MUSANG20"
){

discount = 20;

document
.getElementById(
"discountInfo"
)
.innerText =
"Voucher 20% Aktif";

showToast(
"🎉 Voucher berhasil digunakan"
);

}
else{

discount = 0;

showToast(
"❌ Voucher tidak valid"
);

}

updateCart();

});
/* =========================
   CHECKOUT WHATSAPP
========================= */

const checkoutBtn =
document.getElementById(
"checkoutBtn"
);

checkoutBtn.addEventListener(
"click",
()=>{

if(cart.length === 0){

showToast(
"Keranjang masih kosong"
);

return;

}

let pesan =
"🍈 *PESANAN EGYA DURIAN* 🍈\n\n";

cart.forEach(item=>{

pesan +=
`${item.name}\n`;

pesan +=
`Qty : ${item.qty}\n`;

pesan +=
`Harga : Rp ${item.price.toLocaleString()}\n\n`;

});

let total = 0;

cart.forEach(item=>{

total +=
item.price * item.qty;

});

if(discount > 0){

total =
total -
(total * discount / 100);

}

pesan +=
`💰 Total : Rp ${total.toLocaleString()}\n`;

pesan +=
`🎟️ Diskon : ${discount}%\n`;

pesan +=
`💳 Pembayaran : ${
document.getElementById(
"payment-method"
).value
}\n\n`;

pesan +=
"Terima kasih.";

window.open(

`https://wa.me/6281234567890?text=${encodeURIComponent(pesan)}`,

"_blank"

);

});

/* =========================
   PRODUCT MODAL
========================= */

const modal =
document.getElementById(
"productModal"
);

const modalImage =
document.getElementById(
"modalImage"
);

const modalTitle =
document.getElementById(
"modalTitle"
);

const modalPrice =
document.getElementById(
"modalPrice"
);

const closeModal =
document.getElementById(
"closeModal"
);
let currentImages = [];
let currentIndex = 0;

function updateGallery(){

modalImage.src =
currentImages[currentIndex];

const counter =
document.getElementById(
"photoCounter"
);

if(counter){

counter.innerText =

`${currentIndex+1} / ${currentImages.length}`;

}

}
document
.querySelectorAll(".product-card img")
.forEach(img=>{

img.addEventListener(
"click",
()=>{

const card =
img.closest(".product-card");

currentImages =
JSON.parse(
card.dataset.images
);

currentIndex = 0;

modalTitle.innerText =
card.querySelector("h3")
.innerText;

modalPrice.innerText =
card.querySelector(".price")
.innerText;

updateGallery();

modal.classList.add("show");

});

});

closeModal.addEventListener(
"click",
()=>{

modal.classList.remove("show");

});

modal.addEventListener(
"click",
e=>{

if(e.target === modal){

modal.classList.remove("show");

}

});


/* =========================
   BACK TO TOP
========================= */

const backTop =
document.getElementById(
"backToTop"
);

window.addEventListener(
"scroll",
()=>{

if(window.scrollY > 400){

backTop.style.display =
"block";

}else{

backTop.style.display =
"none";

}

});

backTop.addEventListener(
"click",
()=>{

window.scrollTo({

top:0,
behavior:"smooth"

});

});

/* =========================
   AUTO WELCOME MEMBER
========================= */

const savedMember =
localStorage.getItem(
"memberName"
);

if(savedMember){

setTimeout(()=>{

showToast(
`👋 Selamat Datang ${savedMember}`
);

},1500);

}

/* =========================
   COUNTER ANIMATION
========================= */

const statNumbers =
document.querySelectorAll(
".stat-box h2"
);

function animateCounter(){

statNumbers.forEach(stat=>{

const original =
stat.innerText;

let target =
parseInt(
original.replace(/\D/g,'')
);

if(isNaN(target)) return;

let current = 0;

let increment =
Math.ceil(target / 80);

const interval =
setInterval(()=>{

current += increment;

if(current >= target){

current = target;

clearInterval(interval);

}

if(original.includes("%")){

stat.innerText =
current + "%";

}
else if(
original.includes("+")
){

stat.innerText =
current.toLocaleString() + "+";

}
else{

stat.innerText =
current;

}

},20);

});

}

let counterStarted =
false;

window.addEventListener(
"scroll",
()=>{

const stats =
document.querySelector(
".stats"
);

if(!stats) return;

const position =
stats.getBoundingClientRect()
.top;

if(
position <
window.innerHeight - 100
&& !counterStarted
){

counterStarted = true;

animateCounter();

}

});

/* =========================
   SCROLL FADE EFFECT
========================= */

const observer =
new IntersectionObserver(

entries=>{

entries.forEach(entry=>{

if(entry.isIntersecting){

entry.target.classList.add(
"fade-up"
);

}

});

},

{
threshold:.2
}

);

document
.querySelectorAll(
".product-card,.about,.gallery,.testimonial-card,.faq-item,.contact"
)
.forEach(el=>{

observer.observe(el);

});

/* =========================
   FLOATING EFFECT
========================= */

document
.querySelectorAll(
".hero-btn,.floating-wa"
)
.forEach(el=>{

el.classList.add("float");

});

/* =========================
   SAVE DARK MODE
========================= */

window.addEventListener(
"beforeunload",
()=>{

localStorage.setItem(
"darkMode",
document.body.classList.contains(
"dark"
)
);

});

/* =========================
   RESET CART AFTER SUCCESS
========================= */

function clearCart(){

cart = [];

updateCart();

saveCart();

}

/* =========================
   KEYBOARD SHORTCUT
========================= */

document.addEventListener(
"keydown",
e=>{

if(e.key === "Escape"){

modal.classList.remove(
"show"
);

closeSidebar();

}

});

/* =========================
   PRELOAD IMAGES
========================= */

function preloadImages(){

const images = [

"assets/hero.jpg",
"assets/musangking.jpg",
"assets/blackthorn.jpg",
"assets/monthong.jpg",
"assets/kupas.jpg",
"assets/pancake.jpg"

];

images.forEach(src=>{

const img =
new Image();

img.src = src;

});

}

preloadImages();

/* =========================
   COPYRIGHT CONSOLE
========================= */

console.log(
"%c🍈 EGYA DURIAN PREMIUM WEBSITE",
"color:#146c2f;font-size:20px;font-weight:bold"
);

console.log(
"%cDeveloped For EGYA DURIAN",
"color:#FFD700;font-size:14px"
);

const galleryPrev =
document.getElementById(
"galleryPrev"
);

const galleryNext =
document.getElementById(
"galleryNext"
);

if(galleryPrev && galleryNext){

galleryNext.addEventListener(
"click",
()=>{

currentIndex++;

if(
currentIndex >=
currentImages.length
){

currentIndex = 0;

}

updateGallery();

});

galleryPrev.addEventListener(
"click",
()=>{

currentIndex--;

if(
currentIndex < 0
){

currentIndex =
currentImages.length - 1;

}

updateGallery();

});

}

const galleryItems =
document.querySelectorAll(".gallery-item");
console.log("galleryItems =", galleryItems.length);

const galleryModal =
document.getElementById("galleryModal");

const galleryModalImage =
document.getElementById("galleryModalImage");
console.log("galleryModalImage =", galleryModalImage);

console.log("galleryModal =", galleryModal);

const galleryCounter =
document.getElementById("galleryModalCounter");

let galleryIndex = 0;

const galleryImages =
Array.from(galleryItems).map(
img=>img.src
);

console.log(galleryImages);
console.log("galleryImages =", galleryImages.length);


function updateGalleryModal(){

galleryModalImage.src =
galleryImages[galleryIndex];

galleryCounter.innerText =
`${galleryIndex+1} / ${galleryImages.length}`;

}

galleryItems.forEach(
(item,index)=>{

item.addEventListener(
"click",
()=>{

galleryIndex = index;

updateGalleryModal();

galleryModal.classList.add(
"show"
);

});

});

document
.getElementById(
"galleryModalNext"
)
.addEventListener(
"click",
()=>{

galleryIndex++;

if(
galleryIndex >=
galleryImages.length
){

galleryIndex = 0;

}

updateGalleryModal();

});

document
.getElementById(
"galleryModalPrev"
)
.addEventListener(
"click",
()=>{

galleryIndex--;

if(
galleryIndex < 0
){

galleryIndex =
galleryImages.length-1;

}

updateGalleryModal();

});

document
.getElementById(
"closeGallery"
)
.addEventListener(
"click",
()=>{

galleryModal.classList.remove("show");

console.log("CLOSE CLICKED");

});

let startX = 0;

galleryModalImage.addEventListener(
"touchstart",
e=>{

startX =
e.touches[0].clientX;

});

galleryModalImage.addEventListener(
"touchend",
e=>{

const endX =
e.changedTouches[0].clientX;

if(startX - endX > 50){

document
.getElementById(
"galleryModalNext"
)
.click();

}

if(endX - startX > 50){

document
.getElementById(
"galleryModalPrev"
)
.click();

}

});
/* =========================
   END OF SCRIPT.JS BY: Hryntp_
========================= */