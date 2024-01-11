const date = new Date().getFullYear();

const Footer = () => {
  return (
    <div className="footer footer-center bg-neutral text-neutral-content fixed bottom-0">
      <aside>
        <p className='m-2'>Copyright © {date} - All rights reserved by Arranged Godly</p>
      </aside>
    </div>
  );
};

export default Footer;
