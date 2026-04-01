'use strict';

// Scroll-in animations
const observer = new IntersectionObserver((entries) => {
  entries.forEach(el => {
    if (el.isIntersecting) el.target.classList.add('visible');
  });
}, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });

document.querySelectorAll('.animate').forEach(el => observer.observe(el));

// Active whitepaper nav highlight
const wpBlocks = document.querySelectorAll('.wp-block');
const wpNavItems = document.querySelectorAll('.wp-nav-item');
const wpObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      wpNavItems.forEach(n => n.classList.remove('active'));
      const activeNav = document.querySelector(`.wp-nav-item[href="#${entry.target.id}"]`);
      if (activeNav) activeNav.classList.add('active');
    }
  });
}, { threshold: 0.5 });
wpBlocks.forEach(b => wpObserver.observe(b));

// Stagger feature cards on scroll-in
document.querySelectorAll('.feat-card').forEach((card, i) => {
  card.style.transitionDelay = `${i * 0.06}s`;
});
