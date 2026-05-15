import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import '../styles/homePageStyles.css'; 

export default function HomePageScreen() {
  const navigate = useNavigate();

  // Load saved theme on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
  }, []);

  
  const handleLoginClick = () => {
    navigate('/login');
  };

  return (
    <div className="home-container">
      <div className="home-overlay">
        <div className="home-card-sts">

<div className="logo-wrapper">
          <img 
            src={require('../assets/images/STS_Logo.png')} 
            alt="STS Logo" 
            className="sts-logo-img" 
          />
        </div>

          <h1 className="school-name-title">SAINT THERESE SCHOOL</h1>
          <p className="welcome-subtext">Welcome to the Gamified Portal</p>
          <p className="instruction-text">Please Login to continue</p>
          

          <div className="home-buttons-group">
            <button className="sts-main-btn" onClick={handleLoginClick}>
              LOGIN
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}