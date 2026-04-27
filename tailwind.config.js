/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./*.html",                 // Main folder ki files jaise index.html, login.html
    "./app/**/*.{html,js}",     // App folder ke andar ki saari files (inbox, dashboard, etc.)
    "./company/**/*.{html,js}", 
    "./features/**/*.{html,js}",
    "./platform/**/*.{html,js}",
    "./legal/**/*.{html,js}"    
  ],
  theme: {
    extend: {
      colors: {
        'omkun-blue': '#1D4ED8',      
        'omkun-darkblue': '#0F172A',  
        'omkun-orange': '#F97316',    
        'omkun-light': '#F8FAFC',     
        'whatsapp': '#25D366',        // Original WhatsApp Green
        'wa-dark': '#00A884',         // Aapke inbox.html me use hua send button ka color
        'wa-bg': '#EFEAE2',           // WhatsApp jaisa chat background color
      }
    },
  },
  plugins: [],
      }
