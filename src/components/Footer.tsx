const date = new Date().getFullYear();

const Footer = () => {
  return (
    <div className="footer footer-center bg-neutral text-neutral-content fixed bottom-0 p-2 text-lg">
      <aside>
        <p className='p-1 text-sm'>Copyright © {date} - All rights reserved by Arranged Godly</p>
      </aside>
    </div>
  );
};

export default Footer;
