const Release = ({ release }: any) => {
  return (
    <div className="card w-[150px] bg-base-100 shadow-xl image-full m-5">
      <figure>
        <img src={release.image} alt={release.title} />
      </figure>
      <div className="justify-end card-body text-center">
        <h2 className="card-title m-auto text-4xl">{release.title}</h2>
      </div>
    </div>
  );
};

export default Release;
