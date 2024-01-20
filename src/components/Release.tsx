const Release = ({ release }: any) => {
  return (
    <div className="card max-w-[150px] max-h-[150px] bg-base-100 shadow-xl image-full m-5">
      <figure>
        <img src={release.image} alt={release.name} />
      </figure>
      <div className="justify-end card-body text-center">
        <h2 className="card-title m-auto text-xl">{release.name}</h2>
      </div>
    </div>
  );
};

export default Release;
